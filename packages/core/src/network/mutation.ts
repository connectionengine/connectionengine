/**
 * Mutation pipeline — flush and apply. It holds no crypto.
 *
 * It lives in `network/`, because the whole pipeline exists only as a
 * consequence of distributed state. That includes the authored queue, the event
 * log, the dispatch, and the receive-and-apply path.
 *
 * Two paths share one schema:
 *   `event` channel      — reliable, governance-validated, and event-sourced. A
 *                        local write marks a dirty entry or pushes to a queue.
 *                        flushAuthored serialises the current state, stamps
 *                        { author, timestamp }, appends to the event log, and
 *                        dispatches the envelope across every routed network.
 *   `continuous` channel — binary, and authority-checked. A local write sets a
 *                        dirty flag. flushRuntime drains the dirty map and
 *                        dispatches it to the publishRuntime hook of each
 *                        routed network.
 *
 * Receive paths:
 *   `event`      — applyAuthoredEnvelope, in this file. The runtime mode
 *                  verifies and unwraps the envelope before it calls that
 *                  function. Engine-internal governance filters the events.
 *                  The standing check of the authority module,
 *                  `checkAuthorityChangeStanding`, runs inline for every
 *                  `AuthoritativeFor` event.
 *   `continuous` — the binary pipeline reads straight into the SoA stores. It
 *                  needs no separate apply function.
 *
 * The event log is one canonical history per world. Networks are sync topology,
 * not data space. They carry the same events over different connections.
 */

import type { AuthoredEnvelope, AuthoredEvent, Entity, World } from '../ecs/world'
import {
  getComponentById,
  hasComponent,
  hasContinuousFields,
  removeComponent,
  serialiseComponentValue,
  setComponent
} from '../ecs/component'
import { addRelation, getRelationByName, removeRelation } from '../ecs/relation'
import { DESTROY_PREDICATE, getEntityPath, removeEntity, resolveEntityPath, ensureEntityPath } from '../ecs/entity'
import { checkAuthorityChangeStanding, OwnedBy } from './authority'
import type { Network } from './network'
import { getNetwork, getNetworks, publishAuthored, publishRuntime, validateAuthored } from './network'

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

// ── Type guard ──────────────────────────────────────────────────────────────-

/** Type guard for an authored envelope arriving over a transport channel. */
export const isAuthoredEnvelope = (payload: unknown): payload is AuthoredEnvelope =>
  !!payload && typeof payload === 'object' && Array.isArray((payload as { events?: unknown }).events)

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
 * Drain the dirty set and queues. Serialise each pending mutation as an
 * AuthoredEvent. Stamp the author and the timestamp. Append to the event log.
 * Dispatch the envelope across every routed network. Call this function at
 * the end of the tick.
 */
export const flushAuthored = (world: World): AuthoredEnvelope | undefined => {
  if (world.componentDirty.size === 0 && world.relationQueue.length === 0 && world.destroyQueue.length === 0)
    return undefined
  const events: AuthoredEvent[] = []
  const eventsByEntity: Array<{ entity: Entity; event: AuthoredEvent }> = []
  const now = world.engine.clock.now()
  const author = world.localAgent.did

  for (const [componentId, entities] of world.componentDirty) {
    const component = getComponentById(componentId)
    if (!component) continue
    for (const entity of entities) {
      const path = getEntityPath(world, entity)
      if (path.length === 0) continue
      const present = hasComponent(world, entity, component)
      const event: AuthoredEvent = {
        entityPath: path,
        predicate: componentId,
        op: present ? 'set' : 'remove',
        value: present ? serialiseComponentValue(world, entity, component) : undefined,
        author,
        timestamp: now,
        seq: world.authoredSeq++
      }
      if (!appendEventLog(world, event)) continue
      events.push(event)
      eventsByEntity.push({ entity, event })
    }
  }
  world.componentDirty.clear()

  for (const queued of world.relationQueue) {
    const path = getEntityPath(world, queued.entity)
    if (path.length === 0) continue
    const targetPath = getEntityPath(world, queued.target)
    if (targetPath.length === 0) continue
    const event: AuthoredEvent = {
      entityPath: path,
      predicate: queued.predicate,
      op: queued.op,
      value: { targetPath },
      author,
      timestamp: now,
      seq: world.authoredSeq++
    }
    if (!appendEventLog(world, event)) continue
    events.push(event)
    eventsByEntity.push({ entity: queued.entity, event })
  }
  world.relationQueue.length = 0

  for (const queued of world.destroyQueue) {
    if (world.localUser === undefined || queued.indexed?.get(OwnedBy) !== world.localUser) continue
    const event: AuthoredEvent = {
      entityPath: queued.entityPath,
      predicate: DESTROY_PREDICATE,
      op: 'destroy',
      value: undefined,
      author,
      timestamp: now,
      seq: world.authoredSeq++
    }
    if (!appendEventLog(world, event)) continue
    events.push(event)
    eventsByEntity.push({ entity: queued.entity, event })
  }
  world.destroyQueue.length = 0

  if (events.length === 0) return undefined

  const envelope: AuthoredEnvelope = { events, fromPeer: author }

  const networks = Array.from(getNetworks(world).values())
  if (networks.length === 1) {
    publishAuthored(world, networks[0], envelope)
  } else if (networks.length > 1) {
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
    const def = getComponentById(componentId)
    if (!def || !hasContinuousFields(def)) {
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

// ── Echo suppression ─────────────────────────────────────────────────────────

/**
 * Run a block of mutations without accumulating dirty entries. Save the
 * dirty state before, run the callback, restore afterwards. Use this at
 * receive boundaries that apply network state in bulk (snapshot apply,
 * session handshake peer materialisation).
 */
export const withoutAuthoring = (world: World, fn: () => void): void => {
  const savedComponentDirty = new Map([...world.componentDirty].map(([id, set]) => [id, new Set(set)] as const))
  const savedRelationQueue = [...world.relationQueue]
  const savedDestroyQueue = [...world.destroyQueue]
  const savedRuntimeDirty = new Map([...world.runtimeDirty].map(([id, set]) => [id, new Set(set)] as const))
  fn()
  world.componentDirty = savedComponentDirty
  world.relationQueue = savedRelationQueue
  world.destroyQueue = savedDestroyQueue
  world.runtimeDirty = savedRuntimeDirty
}

// ── Receive + apply ───────────────────────────────────────────────────────────

/**
 * Apply an authored envelope that arrived over a network. The runtime mode must
 * verify the signatures and unwrap the envelope before it calls this function.
 * Engine-internal governance (`validateEvent`) runs for each event.
 *
 * The return value lists the events this peer accepted and logged, in arrival
 * order. `rebroadcastAuthored` relays exactly that list. A peer therefore
 * forwards what it accepted, and never forwards what governance refused.
 */
export const applyAuthoredEnvelope = (world: World, envelope: AuthoredEnvelope): AuthoredEvent[] => {
  const accepted: AuthoredEvent[] = []
  for (const event of envelope.events) {
    if (!validateAuthored(world, event)) continue
    // An authority transfer must come from a peer that holds standing. That
    // means a peer of the owner-user, or the current authority holder. This is
    // a direct call into the authority module. Both modules live in network/,
    // so it needs no cross-layer plumbing.
    const standing = checkAuthorityChangeStanding(world, event)
    if (standing !== undefined) continue
    // Already in the log. Not an error — a mesh delivers the same event by
    // several paths — so it reports nothing.
    if (!appendEventLog(world, event)) continue
    withoutAuthoring(world, () => applyEvent(world, event))
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

  const component = getComponentById(event.predicate)
  if (component) {
    if (event.op === 'set') {
      setComponent(world, entity, component, (event.value ?? {}) as Record<string, unknown>)
    } else if (event.op === 'remove') {
      removeComponent(world, entity, component)
    }
    return
  }

  const relation = getRelationByName(event.predicate)
  if (relation) {
    const targetPath = (event.value as { targetPath?: string[] } | null)?.targetPath
    if (!targetPath) return
    const target = ensureEntityPath(world, targetPath)
    if (event.op === 'set') addRelation(world, entity, relation, target)
    else if (event.op === 'remove') removeRelation(world, entity, relation, target)
  }
}
