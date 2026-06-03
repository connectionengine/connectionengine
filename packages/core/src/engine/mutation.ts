/**
 * Mutation pipeline — flush + apply (engine-level, no crypto).
 *
 * Two paths share one schema:
 *   `event` channel    — reliable, governance-validated, event-sourced. Local
 *                        writes enqueue { entity, predicate, op, value } in
 *                        world.authoredQueue. flushAuthored resolves paths,
 *                        stamps {author, timestamp}, appends to the world's
 *                        event log (idempotent), then dispatches the envelope
 *                        across every network reachable from the entity (via
 *                        `routeNetworks`).
 *   `continuous` channel — binary, authority-checked. Local writes set dirty
 *                        flags; flushRuntime drains and dispatches the dirty
 *                        map to each routed network's publishRuntime hook.
 *
 * Receive paths:
 *   `event` — applyAuthoredEnvelope (here). Runtime mode verifies + unwraps
 *             before calling. Per-network governance gate filters.
 *   `continuous` — the binary pipeline reads directly into SoA stores; no
 *                  separate apply function.
 *
 * The event log is one canonical history per world. Networks are sync
 * topology, not data space — same events, different connections.
 */

import type { AuthoredEnvelope, AuthoredEvent, Entity, Network, World } from '../ecs/world'
import type { ComponentDefinition } from '../ecs/component'
import { allComponents, getComponentById, removeComponent, setComponent } from '../ecs/component'
import type { RelationDefinition } from '../ecs/relation'
import { addRelation, getRelationByName, removeRelation } from '../ecs/relation'
import { getEntityByUID, getEntityPath, resolveEntityPath, setUID } from '../ecs/identity'
import { createEntity, removeEntity } from '../ecs/entity'

/**
 * Routing strategy: which networks receive a mutation for the given entity?
 * Today: broadcast-to-all. Spatial-segmentation will replace this in a higher
 * layer.
 */
const routeNetworks = (world: World, _entity: Entity): Network[] => {
  void _entity
  return Array.from(world.networks.values())
}

// ── Predicate resolution ─────────────────────────────────────────────────────-
//
// Components and relations are engine-global; resolving a predicate id from
// an incoming event is just an engine-registry lookup.

const findComponent = (world: World, id: string): ComponentDefinition | undefined => getComponentById(id, world.engine)

const findRelation = (world: World, name: string): RelationDefinition<unknown> | undefined =>
  getRelationByName(name, world.engine)

/** Iterate every component defined on this world's engine (for snapshot / walks). */
export const worldComponents = (world: World): ComponentDefinition[] => allComponents(world.engine)

/** Iterate every relation defined on this world's engine. */
export const worldRelations = (world: World): RelationDefinition<unknown>[] =>
  Array.from(world.engine.relations.values())

// ── Event log append (idempotent on signature) ───────────────────────────────-

export const eventSignature = (e: AuthoredEvent): string =>
  `${e.author}|${e.timestamp}|${e.op}|${e.predicate}|${e.entityPath.join('/')}|${JSON.stringify(e.value ?? null)}`

export const appendEventLog = (world: World, event: AuthoredEvent): boolean => {
  const sig = eventSignature(event)
  if (world.eventLogSeen.has(sig)) return false
  world.eventLog.push(event)
  world.eventLogSeen.add(sig)
  return true
}

export const hasEventBeenSeen = (world: World, event: AuthoredEvent): boolean =>
  world.eventLogSeen.has(eventSignature(event))

// ── Flush ─────────────────────────────────────────────────────────────────────

/**
 * Drain authored queue, resolve paths, stamp author+timestamp, append to the
 * world's event log, dispatch the envelope across every routed network. Call
 * at end of tick.
 *
 * Network routing today is broadcast-to-all (see `routeNetworks`). The hook
 * exists so spatial-segmentation can later restrict per-entity.
 */
export const flushAuthored = (world: World): AuthoredEnvelope | undefined => {
  if (world.authoredQueue.length === 0) return undefined
  const events: AuthoredEvent[] = []
  // We group events by their per-entity routing decision so each network only
  // receives what's relevant. Today routing is broadcast — the per-network
  // grouping collapses to "every event goes to every network".
  const eventsByEntity: Array<{ entity: Entity; event: AuthoredEvent }> = []
  const now = world.clock.now()
  const author = world.localAgent.did
  for (const queued of world.authoredQueue) {
    if (queued.origin !== 'local') continue
    const path = getEntityPath(world, queued.entity)
    if (path.length === 0) continue // anonymous entity — not addressable on the wire
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
    eventsByEntity.push({ entity: queued.entity, event })
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
  // Dispatch per entity through `routeNetworks`. Today broadcast-to-all, so
  // we collapse to one envelope per network for efficiency.
  const perNetwork = new Map<string, AuthoredEvent[]>()
  for (const { entity, event } of eventsByEntity) {
    for (const network of routeNetworks(world, entity)) {
      const bucket = perNetwork.get(network.id)
      if (bucket) bucket.push(event)
      else perNetwork.set(network.id, [event])
    }
  }
  for (const [networkId, networkEvents] of perNetwork) {
    const network = world.networks.get(networkId)
    if (!network) continue
    const envelope: AuthoredEnvelope = { events: networkEvents, fromPeer: author }
    network.publishAuthored?.(envelope)
    world.trace.emit({
      kind: 'transport.send',
      ts: world.clock.now(),
      peer: envelope.fromPeer,
      detail: { kind: 'authored', count: envelope.events.length, network: networkId }
    })
  }
  return { events, fromPeer: author }
}

/**
 * Drain the runtime dirty set and publish to every routed network's binary
 * channel. Returns the snapshot for trace / inspection.
 */
export const flushRuntime = (world: World): Map<string, Set<Entity>> | undefined => {
  if (world.runtimeDirty.size === 0) return undefined
  const snapshot = new Map<string, Set<Entity>>()
  for (const [componentId, entities] of world.runtimeDirty) {
    if (entities.size === 0) continue
    const def = findComponent(world, componentId)
    if (!def || !def.$isBinary) {
      entities.clear()
      continue
    }
    snapshot.set(componentId, new Set(entities))
    entities.clear()
  }
  if (snapshot.size === 0) return undefined
  // Group dirty entries per network using routeNetworks. Today broadcast.
  const perNetwork = new Map<string, Map<string, Set<Entity>>>()
  for (const [componentId, entities] of snapshot) {
    for (const entity of entities) {
      for (const network of routeNetworks(world, entity)) {
        let m = perNetwork.get(network.id)
        if (!m) {
          m = new Map()
          perNetwork.set(network.id, m)
        }
        let s = m.get(componentId)
        if (!s) {
          s = new Set()
          m.set(componentId, s)
        }
        s.add(entity)
      }
    }
  }
  for (const [networkId, dirty] of perNetwork) {
    const network = world.networks.get(networkId)
    if (!network) continue
    network.publishRuntime?.(dirty)
    let count = 0
    for (const set of dirty.values()) count += set.size
    world.trace.emit({
      kind: 'transport.send',
      ts: world.clock.now(),
      peer: world.localAgent.did,
      detail: { kind: 'runtime', count, network: networkId }
    })
  }
  return snapshot
}

// ── Receive + apply ───────────────────────────────────────────────────────────

/**
 * Apply an authored envelope received over a network. The runtime mode is
 * responsible for verifying signatures / unwrapping before calling this. If
 * `network` is provided, its `validateAuthored` gate runs per event.
 */
export const applyAuthoredEnvelope = (
  world: World,
  envelope: AuthoredEnvelope,
  network?: import('../network/network').Network
): void => {
  world.trace.emit({
    kind: 'transport.receive',
    ts: world.clock.now(),
    peer: envelope.fromPeer,
    detail: { kind: 'authored', count: envelope.events.length, network: network?.id }
  })
  const gate = network?.validateAuthored
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

  const component = findComponent(world, event.predicate)
  if (component) {
    if (event.op === 'set') {
      setComponent(world, entity, component, (event.value ?? {}) as Record<string, unknown>, { origin: 'network' })
    } else if (event.op === 'remove') {
      removeComponent(world, entity, component, { origin: 'network' })
    }
    return
  }

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
  let parent: Entity = world.worldRoot
  let cursor: Entity = world.worldRoot
  for (const uid of path) {
    const existing = getEntityByUID(world, parent, uid)
    if (existing !== undefined) {
      cursor = existing
    } else {
      cursor = createEntity(world, { silent: true })
      if (parent === world.worldRoot) setUID(world, cursor, uid, { origin: 'network' })
      else setUID(world, cursor, uid, { parent, origin: 'network' })
    }
    parent = cursor
  }
  return cursor
}
