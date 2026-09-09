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
import { checkAuthorityChangeStanding, OwnedBy } from './authority'
import type { Network } from './network'
import { getNetwork, getNetworks, publishAuthored, publishRuntime, reportRejected, validateAuthored } from './network'

/**
 * Routing strategy. It answers one question: which networks receive a mutation
 * for the given entity? Today it broadcasts to all of them. A higher layer will
 * replace it with spatial segmentation.
 *
 * Both flush paths call this per entity, so the single-network case — every
 * app that has not asked for segmentation — takes the fast path in
 * `flushAuthored` and `flushRuntime` and never builds the grouping maps.
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

/**
 * Identity of an event, for deduplication.
 *
 * `seq` is what makes two writes of the same value in the same millisecond
 * distinct. Author plus seq is enough for an event this peer produced. The
 * rest of the tuple keeps the signature meaningful for an event built by hand
 * in a test, and for anything a runtime mode synthesises.
 */
export const eventSignature = (e: AuthoredEvent): string =>
  `${e.author}|${e.timestamp}|${e.seq}|${e.op}|${e.predicate}|${e.entityPath.join('/')}|${JSON.stringify(e.value ?? null)}`

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
    // The ownership gate on entity removal. `removeEntity` queues every named
    // removal and leaves the decision here, because who may announce a removal
    // is a distribution question, not an ECS one.
    //
    // The same comparison does three jobs. It stops a peer announcing the
    // removal of something it does not own. It suppresses the echo, because a
    // received destroy names an entity owned by the remote user. And it keeps
    // local cleanup local: the disconnect sweep removes entities owned by the
    // departing user, never by this one, so nothing goes out.
    // `undefined === undefined` would let a world with no local identity
    // announce the removal of an unowned entity, so the local user has to
    // exist before any destroy travels.
    if (queued.op === 'destroy' && (world.localUser === undefined || queued.indexed?.get(OwnedBy) !== world.localUser))
      continue
    // A destroy carries the path captured before `removeEntity` cleared the
    // identity caches. Everything else resolves its path now.
    const path = queued.entityPath ?? getEntityPath(world, queued.entity)
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
      timestamp: now,
      seq: world.authoredSeq++
    }
    if (!appendEventLog(world, event)) continue
    events.push(event)
    eventsByEntity.push({ entity: queued.entity, event })
  }
  world.authoredQueue.length = 0
  if (events.length === 0) return undefined

  const networks = Array.from(getNetworks(world).values())
  if (networks.length === 0) return { events, fromPeer: author }

  const envelope: AuthoredEnvelope = { events, fromPeer: author }
  if (networks.length === 1) {
    // One network: every event routes to it, so skip the grouping map.
    publishAuthored(world, networks[0], envelope)
    return envelope
  }

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
    publishAuthored(world, network, { events: networkEvents, fromPeer: author })
  }
  return envelope
}

/**
 * Drain the runtime dirty set, and publish it to the binary channel of every
 * routed network. The function returns the snapshot, so that a caller can
 * inspect it.
 */
export const flushRuntime = (world: World): Map<string, Set<Entity>> | undefined => {
  if (world.runtimeDirty.size === 0) return undefined
  const snapshot = new Map<string, Set<Entity>>()
  // A binary channel can be holding entries that its publish throttle deferred
  // on an earlier tick. Those entries are no longer in `runtimeDirty`, because
  // the drain below clears it, so the channel has to be given a turn even when
  // this tick produced nothing.
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
  const networks = Array.from(getNetworks(world).values())
  if (networks.length === 0) return snapshot.size === 0 ? undefined : snapshot
  if (networks.length === 1) {
    // One network: every entity routes to it, so publish the snapshot as-is.
    publishRuntime(world, networks[0], snapshot)
    return snapshot.size === 0 ? undefined : snapshot
  }
  if (snapshot.size === 0) {
    for (const network of networks) publishRuntime(world, network, snapshot)
    return undefined
  }

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
    publishRuntime(world, network, dirty)
  }
  return snapshot
}

// ── Receive + apply ───────────────────────────────────────────────────────────

/**
 * Apply an authored envelope that arrived over a network. The runtime mode must
 * verify the signatures and unwrap the envelope before it calls this function.
 * When the caller supplies `network`, the `validateAuthored` gate of that
 * network runs for each event.
 *
 * The return value lists the events this peer accepted and logged, in arrival
 * order. `rebroadcastAuthored` relays exactly that list. A peer therefore
 * forwards what it accepted, and never forwards what its own gates refused.
 *
 * Each drop reports through `reportRejected`, so a caller that built the
 * network with an `onRejected` behaviour sees why an event failed to land
 * instead of watching it disappear.
 */
export const applyAuthoredEnvelope = (world: World, envelope: AuthoredEnvelope, network?: Network): AuthoredEvent[] => {
  const accepted: AuthoredEvent[] = []
  for (const event of envelope.events) {
    if (network && !validateAuthored(world, network, event)) {
      reportRejected(world, network, event, 'governance')
      continue
    }
    // An authority transfer must come from a peer that holds standing. That
    // means a peer of the owner-user, or the current authority holder. This is
    // a direct call into the authority module. Both modules live in network/,
    // so it needs no cross-layer plumbing.
    const standing = checkAuthorityChangeStanding(world, event)
    if (standing !== undefined) {
      if (network) reportRejected(world, network, event, `authority: ${standing}`)
      continue
    }
    // Already in the log. Not an error — a mesh delivers the same event by
    // several paths — so it reports nothing.
    if (!appendEventLog(world, event)) continue
    applyEvent(world, event)
    accepted.push(event)
  }
  return accepted
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
