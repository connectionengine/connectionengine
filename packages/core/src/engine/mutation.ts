/**
 * Mutation pipeline — flush + apply (engine-level, no crypto).
 *
 * Two paths share one schema:
 *   AUTHORED — reliable, governance-validated, event-sourced. Local writes
 *              enqueue { entity, predicate, op, value } in world.authoredQueue
 *              (see ecs/component.ts + ecs/relation.ts). flushAuthored
 *              resolves entity paths, stamps {author, timestamp}, calls
 *              world.network.publishAuthored?.(envelope), appends to event log.
 *   RUNTIME  — binary, authority-checked. Local writes set dirty flags;
 *              flushRuntime drains, samples SoA stores, packs per-field
 *              snapshots, calls world.network.publishRuntime?.(envelope).
 *
 * Receive: applyAuthoredEnvelope / applyRuntimeEnvelope are called by the
 * runtime mode after the wire has verified + unwrapped. Both apply with
 * origin='network' to suppress re-broadcast.
 *
 * Signing / verification / wire format are runtime-mode concerns (see
 * @connectionengine/local or @connectionengine/ad4m-bridge). The in-memory
 * transport in network/transport.ts is a no-crypto passthrough useful for
 * tests + solo mode.
 *
 * Maps to canonical doc §3.13 (Realtime Transport & Mutation Pipeline).
 */

import type { AuthoredEnvelope, AuthoredEvent, Entity, RuntimeEnvelope, World } from '../ecs/world'
import type { ComponentDefinition } from '../ecs/component'
import { getComponentById, getSoA, hasComponent, removeComponent, setComponent } from '../ecs/component'
import type { RelationDefinition } from '../ecs/relation'
import { addRelation, getRelationByName, removeRelation } from '../ecs/relation'
import { ROOT_PARENT, getEntityByUID, getEntityPath, resolveEntityPath, setUID } from '../network/identity'
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
    events.push(event)
    world.eventLog.push(event)
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
 * Drain runtime dirty set, sample SoA stores, publish via
 * `world.network.publishRuntime` (if wired).
 */
export const flushRuntime = (world: World): RuntimeEnvelope | undefined => {
  if (world.runtimeDirty.size === 0) return undefined
  const updates: RuntimeEnvelope['updates'] = []
  for (const [componentId, entities] of world.runtimeDirty) {
    if (entities.size === 0) continue
    const def = findComponent(world, componentId)
    if (!def || def.mutationCategory !== 'runtime') {
      entities.clear()
      continue
    }
    for (const entity of entities) {
      const path = getEntityPath(world, entity)
      if (path.length === 0) continue
      const defSoA = getSoA(world, def)
      const soa: Record<string, number | number[]> = {}
      for (const field of def.$soaFields) {
        const store = defSoA[field] as { to?: (entity: number) => unknown } & Record<number, number>
        if (typeof store.to === 'function') soa[field] = store.to(entity) as number | number[]
        else soa[field] = store[entity]
      }
      updates.push({ predicate: componentId, entityPath: path, soa })
    }
    entities.clear()
  }
  if (updates.length === 0) return undefined
  const envelope: RuntimeEnvelope = { updates, fromPeer: world.network.localAgent.did }
  publishRuntime(world, envelope)
  return envelope
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

const publishRuntime = (world: World, envelope: RuntimeEnvelope): void => {
  world.network.publishRuntime?.(envelope)
  world.trace.emit({
    kind: 'transport.send',
    ts: world.clock.now(),
    peer: envelope.fromPeer,
    detail: { kind: 'runtime', count: envelope.updates.length }
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
    applyEvent(world, event)
    world.eventLog.push(event)
    world.trace.emit({
      kind: 'mutation.receive',
      ts: world.clock.now(),
      origin: 'network',
      predicate: event.predicate,
      detail: { author: event.author }
    })
  }
}

/** Apply a runtime envelope (SoA snapshot) received over the wire. */
export const applyRuntimeEnvelope = (world: World, envelope: RuntimeEnvelope): void => {
  world.trace.emit({
    kind: 'transport.receive',
    ts: world.clock.now(),
    peer: envelope.fromPeer,
    detail: { kind: 'runtime', count: envelope.updates.length }
  })
  for (const update of envelope.updates) {
    const component = findComponent(world, update.predicate)
    if (!component || component.mutationCategory !== 'runtime') continue
    let entity = resolveEntityPath(world, update.entityPath)
    if (entity === undefined) entity = ensureEntityPath(world, update.entityPath)
    if (!hasComponent(world, entity, component)) {
      setComponent(world, entity, component, update.soa as Record<string, unknown>, { origin: 'network' })
    } else {
      // Direct SoA write — bypass setComponent so we don't re-mark dirty
      const componentSoA = getSoA(world, component)
      for (const [field, value] of Object.entries(update.soa)) {
        const store = componentSoA[field] as
          | { from?: (entity: number, data: unknown) => void; resize?: (n: number) => void }
          | undefined
        if (!store) continue
        if (typeof store.resize === 'function') store.resize(entity + 1)
        if (typeof store.from === 'function') store.from(entity, value)
        else (store as unknown as { [k: number]: number })[entity] = value as number
      }
      world.trace.emit({
        kind: 'mutation.receive',
        ts: world.clock.now(),
        origin: 'network',
        predicate: update.predicate,
        entity
      })
    }
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
