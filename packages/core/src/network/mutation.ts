/**
 * Mutation pipeline — flush and apply. It holds no crypto.
 *
 * It lives in `network/`, because the whole pipeline exists only as a
 * consequence of distributed state. That includes the authored queue, the event
 * log, the dispatch, and the receive-and-apply path.
 *
 * Two paths share one schema:
 *   `event` channel      — reliable, governance-validated, and event-sourced. A
 *                        local write queues { entity, predicate, op, value } in
 *                        world.authoredQueue. flushAuthored then resolves the
 *                        paths, stamps { author, timestamp }, appends to the
 *                        event log of the world, which is idempotent, and
 *                        dispatches the envelope across every network that
 *                        `routeNetworks` reaches from the entity.
 *   `continuous` channel — binary, and authority-checked. A local write sets a
 *                        dirty flag. flushRuntime drains the dirty map and
 *                        dispatches it to the publishRuntime hook of each
 *                        routed network.
 *
 * Receive paths:
 *   `event`      — applyAuthoredEnvelope, in this file. The runtime mode
 *                  verifies and unwraps the envelope before it calls that
 *                  function. The per-network governance gate filters the
 *                  events. The standing check of the authority module,
 *                  `checkAuthorityChangeStanding`, runs inline for every
 *                  `AuthoritativeFor` event.
 *   `continuous` — the binary pipeline reads straight into the SoA stores. It
 *                  needs no separate apply function.
 *
 * The event log is one canonical history per world. Networks are sync topology,
 * not data space. They carry the same events over different connections.
 */

import type { AuthoredEnvelope, AuthoredEvent, Entity, World } from '../ecs/world'
import type { ComponentDefinition } from '../ecs/component'
import { allComponents, getComponentById, hasSyncedSoA, removeComponent, setComponent } from '../ecs/component'
import type { RelationDefinition } from '../ecs/relation'
import { addRelation, allRelations, getRelationByName, removeRelation } from '../ecs/relation'
import { createEntity, getEntityByUID, getEntityPath, removeEntity, resolveEntityPath, setUID } from '../ecs/entity'
import { checkAuthorityChangeStanding } from './authority'
import type { Network } from './network'
import { getNetwork, getNetworks } from './network'

/**
 * Routing strategy. It answers one question: which networks receive a mutation
 * for the given entity? Today it broadcasts to all of them. A higher layer will
 * replace it with spatial segmentation.
 */
const routeNetworks = (world: World, _entity: Entity): Network[] => {
  void _entity
  return Array.from(getNetworks(world).values())
}

// ── Predicate resolution ─────────────────────────────────────────────────────-
//
// Components and relations are module-level global singletons. Resolution of a
// predicate id from an incoming event is therefore only a registry lookup.

const findComponent = (id: string): ComponentDefinition | undefined => getComponentById(id)

const findRelation = (name: string): RelationDefinition<unknown> | undefined => getRelationByName(name)

/** Iterate every component ever defined. Snapshots and tree walks use it. */
export const worldComponents = (): ComponentDefinition[] => allComponents()

/** Iterate every relation ever defined. */
export const worldRelations = (): RelationDefinition<unknown>[] => allRelations()

// ── Event log append. It is idempotent on the event signature. ───────────────-

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
 * Drain the authored queue. Resolve the paths. Stamp the author and the
 * timestamp. Append to the event log of the world. Dispatch the envelope across
 * every routed network. Call this function at the end of the tick.
 *
 * Network routing broadcasts to all networks today. See `routeNetworks`. That
 * hook exists so that spatial segmentation can later restrict the set per
 * entity.
 */
export const flushAuthored = (world: World): AuthoredEnvelope | undefined => {
  if (world.authoredQueue.length === 0) return undefined
  const events: AuthoredEvent[] = []
  // Group the events by their per-entity routing decision, so that each network
  // receives only the relevant ones. Routing broadcasts today, so the
  // per-network grouping collapses: every event goes to every network.
  const eventsByEntity: Array<{ entity: Entity; event: AuthoredEvent }> = []
  const now = world.engine.clock.now()
  const author = world.localAgent.did
  for (const queued of world.authoredQueue) {
    if (queued.origin !== 'local') continue
    const path = getEntityPath(world, queued.entity)
    if (path.length === 0) continue // anonymous entity. The wire cannot address it.
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
  }
  world.authoredQueue.length = 0
  if (events.length === 0) return undefined
  // Dispatch per entity through `routeNetworks`. It broadcasts to all networks
  // today, so collapse the result to one envelope per network for efficiency.
  const perNetwork = new Map<string, AuthoredEvent[]>()
  for (const { entity, event } of eventsByEntity) {
    for (const network of routeNetworks(world, entity)) {
      const bucket = perNetwork.get(network.id)
      if (bucket) bucket.push(event)
      else perNetwork.set(network.id, [event])
    }
  }
  for (const [networkId, networkEvents] of perNetwork) {
    const network = getNetwork(world, networkId)
    if (!network) continue
    const envelope: AuthoredEnvelope = { events: networkEvents, fromPeer: author }
    network.publishAuthored?.(envelope)
  }
  return { events, fromPeer: author }
}

/**
 * Drain the runtime dirty set, and publish it to the binary channel of every
 * routed network. The function returns the snapshot, so that a caller can
 * inspect it.
 */
export const flushRuntime = (world: World): Map<string, Set<Entity>> | undefined => {
  if (world.runtimeDirty.size === 0) return undefined
  const snapshot = new Map<string, Set<Entity>>()
  for (const [componentId, entities] of world.runtimeDirty) {
    if (entities.size === 0) continue
    const def = findComponent(componentId)
    if (!def || !hasSyncedSoA(def)) {
      entities.clear()
      continue
    }
    snapshot.set(componentId, new Set(entities))
    entities.clear()
  }
  if (snapshot.size === 0) return undefined
  // Group the dirty entries per network with routeNetworks. It broadcasts today.
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
    const network = getNetwork(world, networkId)
    if (!network) continue
    network.publishRuntime?.(dirty)
  }
  return snapshot
}

// ── Receive + apply ───────────────────────────────────────────────────────────

/**
 * Apply an authored envelope that arrived over a network. The runtime mode must
 * verify the signatures and unwrap the envelope before it calls this function.
 * When the caller supplies `network`, the `validateAuthored` gate of that
 * network runs for each event.
 */
export const applyAuthoredEnvelope = (world: World, envelope: AuthoredEnvelope, network?: Network): void => {
  const gate = network?.validateAuthored
  for (const event of envelope.events) {
    if (gate && !gate(event)) continue
    // An authority transfer must come from a peer that holds standing. That
    // means a peer of the owner-user, or the current authority holder. This is
    // a direct call into the authority module. Both modules live in network/,
    // so it needs no cross-layer plumbing.
    if (checkAuthorityChangeStanding(world, event) !== undefined) continue
    if (!appendEventLog(world, event)) continue
    applyEvent(world, event)
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

  const component = findComponent(event.predicate)
  if (component) {
    if (event.op === 'set') {
      setComponent(world, entity, component, (event.value ?? {}) as Record<string, unknown>, { origin: 'network' })
    } else if (event.op === 'remove') {
      removeComponent(world, entity, component, { origin: 'network' })
    }
    return
  }

  const relation = findRelation(event.predicate)
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
      cursor = createEntity(world)
      if (parent === world.worldRoot) setUID(world, cursor, uid, { origin: 'network' })
      else setUID(world, cursor, uid, { parent, origin: 'network' })
    }
    parent = cursor
  }
  return cursor
}
