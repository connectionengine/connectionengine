/**
 * Mutation pipeline — flush + apply (engine-level, no crypto).
 *
 * Two paths share one schema:
 *   AUTHORED — reliable, governance-validated, event-sourced. Local writes
 *              enqueue { entity, predicate, op, value } in world.authoredQueue.
 *              flushAuthored resolves entity paths, stamps {author, timestamp},
 *              appends to event log via appendEventLog (idempotent), calls
 *              world.network.publishAuthored?.(envelope).
 *   RUNTIME  — binary, authority-checked. Local writes set dirty flags;
 *              flushRuntime drains the dirty map and calls
 *              world.network.publishRuntime?.(dirty). The network layer
 *              encodes via the binary pipeline + ships per-connection.
 *
 * Receive paths:
 *   AUTHORED — applyAuthoredEnvelope (here). Runtime mode verifies +
 *              unwraps before calling. Optional governance gate filters.
 *   RUNTIME  — the binary pipeline reads directly into SoA stores; no
 *              applyRuntimeEnvelope is required since the codec is the
 *              receive path.
 *
 * Signing / verification / wire format are runtime-mode concerns (see
 * @connectionengine/local or @connectionengine/ad4m-bridge). The in-memory
 * transport in network/transport.ts is a no-crypto passthrough useful for
 * tests + solo mode.
 */

import type { AuthoredEnvelope, AuthoredEvent, Entity, World } from '../ecs/world'
import type { ComponentDefinition } from '../ecs/component'
import { getComponentById, removeComponent, setComponent } from '../ecs/component'
import type { RelationDefinition } from '../ecs/relation'
import { addRelation, getRelationByName, removeRelation } from '../ecs/relation'
import { ROOT_PARENT, getEntityByUID, getEntityPath, resolveEntityPath, setUID } from '../ecs/identity'
import { createEntity, removeEntity } from '../ecs/entity'

// ── Component / relation registries (per-world, keyed by id/name) ─────────────

const componentDefs = new WeakMap<World, Map<string, ComponentDefinition>>()
const relationDefs = new WeakMap<World, Map<string, RelationDefinition<unknown>>>()

export const registerComponentForPipeline = (world: World, component: ComponentDefinition): void => {
  let map = componentDefs.get(world)
  if (!map) {
    map = new Map()
    componentDefs.set(world, map)
  }
  map.set(component.id, component)
}

export const registerRelationForPipeline = (world: World, relation: RelationDefinition<unknown>): void => {
  let map = relationDefs.get(world)
  if (!map) {
    map = new Map()
    relationDefs.set(world, map)
  }
  map.set(relation.name, relation)
}

// Wire the register hooks so any component/relation used on a world is
// resolvable by the pipeline's receive path.
import { registerComponentRegisterHook } from '../ecs/component'
import { registerRelationRegisterHook } from '../ecs/relation'
registerComponentRegisterHook(registerComponentForPipeline)
registerRelationRegisterHook(registerRelationForPipeline)

/**
 * Resolve a component definition for a given id. Falls back to the global
 * definition registry so receivers can apply events for components that exist
 * in the schema (anywhere) but haven't been touched on this world yet.
 */
const findComponent = (world: World, id: string): ComponentDefinition | undefined =>
  componentDefs.get(world)?.get(id) ?? getComponentById(id)

const findRelation = (world: World, name: string): RelationDefinition<unknown> | undefined =>
  relationDefs.get(world)?.get(name) ?? getRelationByName(name)

/** Iterate every component registered against a world (for snapshot/walks). */
export const worldComponents = (world: World): ComponentDefinition[] =>
  Array.from(componentDefs.get(world)?.values() ?? [])

/** Iterate every relation registered against a world. */
export const worldRelations = (world: World): RelationDefinition<unknown>[] =>
  Array.from(relationDefs.get(world)?.values() ?? [])

// ── Event log append (idempotent on signature) ───────────────────────────────-

/**
 * Composite key used to dedup events across all append paths. Two events with
 * identical (author, ms-timestamp, op, predicate, path, value) are considered
 * the same event — sufficient in practice and conflict only for events that
 * are literally indistinguishable.
 */
export const eventSignature = (e: AuthoredEvent): string =>
  `${e.author}|${e.timestamp}|${e.op}|${e.predicate}|${e.entityPath.join('/')}|${JSON.stringify(e.value ?? null)}`

/**
 * Append an event to the world's event log iff its signature is not already
 * recorded. Returns true if appended, false if dropped as duplicate. Use this
 * from every push path: local flush, network apply, replay handler.
 */
export const appendEventLog = (world: World, event: AuthoredEvent): boolean => {
  const sig = eventSignature(event)
  if (world.eventLogSeen.has(sig)) return false
  world.eventLog.push(event)
  world.eventLogSeen.add(sig)
  return true
}

/** True iff this exact event has already been recorded on the world. */
export const hasEventBeenSeen = (world: World, event: AuthoredEvent): boolean =>
  world.eventLogSeen.has(eventSignature(event))

// ── Flush ─────────────────────────────────────────────────────────────────────

/**
 * Drain authored queue, resolve paths, stamp author+timestamp, publish via
 * `world.network.publishAuthored` (if wired), append to event log. Call at
 * end of tick.
 */
export const flushAuthored = (world: World): AuthoredEnvelope | undefined => {
  if (world.authoredQueue.length === 0) return undefined
  const events: AuthoredEvent[] = []
  const now = world.clock.now()
  const author = world.network.localAgent.did
  for (const queued of world.authoredQueue) {
    if (queued.origin !== 'local') continue
    const path = getEntityPath(world, queued.entity)
    if (path.length === 0) continue // anonymous entity — not addressable on the wire
    // For relation events we need the target's path too
    let value: unknown = queued.value
    if (value && typeof value === 'object' && 'target' in value) {
      const targetPath = getEntityPath(world, (value as { target: Entity }).target)
      if (targetPath.length === 0) continue
      value = { targetPath }
    }
    const event: AuthoredEvent = {
      entityPath: path,
      predicate: queued.predicate,
      op: queued.op,
      value,
      author,
      timestamp: now
    }
    if (!appendEventLog(world, event)) continue
    events.push(event)
    world.trace.emit({
      kind: 'mutation.emit',
      ts: now,
      origin: 'local',
      predicate: queued.predicate,
      entity: queued.entity,
      peer: author
    })
  }
  world.authoredQueue.length = 0
  if (events.length === 0) return undefined
  const envelope: AuthoredEnvelope = { events, fromPeer: author }
  publishAuthored(world, envelope)
  return envelope
}

/**
 * Drain the runtime dirty set and publish to the network layer.
 *
 * Hands the network layer a snapshot of the dirty map (componentId → entities)
 * — the network layer is responsible for encoding via the binary pipeline and
 * fanning out per-connection (per-connection shadow maps mean each peer can
 * have an independent picture of what's been delivered).
 *
 * Returns the snapshot for trace / inspection. `undefined` if nothing dirty.
 */
export const flushRuntime = (world: World): Map<string, Set<Entity>> | undefined => {
  if (world.runtimeDirty.size === 0) return undefined
  const snapshot = new Map<string, Set<Entity>>()
  for (const [componentId, entities] of world.runtimeDirty) {
    if (entities.size === 0) continue
    const def = findComponent(world, componentId)
    if (!def || !def.isBinary) {
      entities.clear()
      continue
    }
    snapshot.set(componentId, new Set(entities))
    entities.clear()
  }
  if (snapshot.size === 0) return undefined
  publishRuntime(world, snapshot)
  return snapshot
}

const publishAuthored = (world: World, envelope: AuthoredEnvelope): void => {
  world.network.publishAuthored?.(envelope)
  world.trace.emit({
    kind: 'transport.send',
    ts: world.clock.now(),
    peer: envelope.fromPeer,
    detail: { kind: 'authored', count: envelope.events.length }
  })
}

const publishRuntime = (world: World, dirty: Map<string, Set<Entity>>): void => {
  world.network.publishRuntime?.(dirty)
  let count = 0
  for (const set of dirty.values()) count += set.size
  world.trace.emit({
    kind: 'transport.send',
    ts: world.clock.now(),
    peer: world.network.localAgent.did,
    detail: { kind: 'runtime', count }
  })
}

// ── Receive + apply ───────────────────────────────────────────────────────────

/**
 * Apply an authored envelope received over the wire. The runtime mode is
 * responsible for verifying signatures / unwrapping expressions before
 * calling this. Optional `validateAuthored` on `world.network` filters
 * events before apply (governance gate).
 */
export const applyAuthoredEnvelope = (world: World, envelope: AuthoredEnvelope): void => {
  world.trace.emit({
    kind: 'transport.receive',
    ts: world.clock.now(),
    peer: envelope.fromPeer,
    detail: { kind: 'authored', count: envelope.events.length }
  })
  const gate = world.network.validateAuthored
  for (const event of envelope.events) {
    if (gate && !gate(event)) {
      world.trace.emit({
        kind: 'mutation.reject',
        ts: world.clock.now(),
        predicate: event.predicate,
        detail: { reason: 'governance' }
      })
      continue
    }
    if (!appendEventLog(world, event)) continue
    applyEvent(world, event)
    world.trace.emit({
      kind: 'mutation.receive',
      ts: world.clock.now(),
      origin: 'network',
      predicate: event.predicate,
      detail: { author: event.author }
    })
  }
}

const applyEvent = (world: World, event: AuthoredEvent): void => {
  let entity = resolveEntityPath(world, event.entityPath)

  if (event.op === 'destroy') {
    if (entity !== undefined) removeEntity(world, entity)
    return
  }

  if (entity === undefined) {
    entity = ensureEntityPath(world, event.entityPath)
  }

  // Component event
  const component = findComponent(world, event.predicate)
  if (component) {
    if (event.op === 'set') {
      setComponent(world, entity, component, (event.value ?? {}) as Record<string, unknown>, { origin: 'network' })
    } else if (event.op === 'remove') {
      removeComponent(world, entity, component, { origin: 'network' })
    }
    return
  }

  // Relation event — value carries the target entity path
  const relation = findRelation(world, event.predicate)
  if (relation) {
    const targetPath = (event.value as { targetPath?: string[] } | null)?.targetPath
    if (!targetPath) return
    const target = ensureEntityPath(world, targetPath)
    if (event.op === 'set') addRelation(world, entity, relation, target, { origin: 'network' })
    else if (event.op === 'remove') removeRelation(world, entity, relation, target, { origin: 'network' })
  }
}

const ensureEntityPath = (world: World, path: string[]): Entity => {
  let parent: Entity = ROOT_PARENT
  let cursor: Entity = ROOT_PARENT
  for (const uid of path) {
    const existing = getEntityByUID(world, parent, uid)
    if (existing !== undefined) {
      cursor = existing
    } else {
      cursor = createEntity(world, { silent: true })
      if (parent === ROOT_PARENT) setUID(world, cursor, uid, { origin: 'network' })
      else setUID(world, cursor, uid, { parent, origin: 'network' })
    }
    parent = cursor
  }
  return cursor
}
