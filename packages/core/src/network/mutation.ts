/**
 * Mutation pipeline — flush and apply. It holds no crypto.
 *
 * It lives in `network/`, because the whole pipeline exists only as a
 * consequence of distributed state.
 *
 * Two channels:
 *   `event`      — reliable, governance-validated, event-sourced. Local
 *                  mutation verbs (`setComponent`, `addRelation`, etc.)
 *                  append AuthoredEvents to the world's event log at mutation
 *                  time. `flushAuthored` reads from the cursor, filters by
 *                  local author, and broadcasts. Destroy events stay
 *                  queue-based for the ownership gate.
 *   `continuous` — binary, authority-checked. `flushRuntime` drains the
 *                  runtimeDirty map and dispatches via `publishRuntime`.
 *
 * Receive path:
 *   `event`      — `applyAuthoredEnvelope` validates, appends to the log for
 *                  dedup, and applies through raw ECS ops (no re-emission).
 *   `continuous` — the binary pipeline reads straight into SoA stores.
 *
 * The event log holds one canonical history per world. Networks carry the same
 * events over different connections.
 */

import type { AuthoredEnvelope, AuthoredEvent, Entity, World } from '../ecs/world'
import { appendEventLog } from '../ecs/event-log'
import { eraseComponent, getComponentById, hasContinuousFields, writeComponent } from '../ecs/component'
import { eraseRelation, getRelationByName, writeRelation } from '../ecs/relation'
import { DESTROY_PREDICATE, destroyEntity, resolveEntityPath, ensureEntityPath } from '../ecs/entity'
import { checkAuthorityChangeStanding, OwnedBy } from './authority'
import { getNetworks, publishAuthored, publishRuntime, validateAuthored } from './network'

// ── Type guard ──────────────────────────────────────────────────────────────-

/** Type guard for an authored envelope arriving over a transport channel. */
export const isAuthoredEnvelope = (payload: unknown): payload is AuthoredEnvelope =>
  !!payload && typeof payload === 'object' && Array.isArray((payload as { events?: unknown }).events)

export { eventSignature, appendEventLog, hasEventBeenSeen } from '../ecs/event-log'

// ── Flush ─────────────────────────────────────────────────────────────────────

/**
 * Read the event log from the cursor, collect locally authored events, drain
 * the destroy queue (with the ownership gate), broadcast. Advance the cursor.
 *
 * Component and relation events land in the log at mutation time (event-first).
 * Destroy events land here at flush time because the ownership check needs
 * `OwnedBy`, which `ecs/` cannot reach.
 */
export const flushAuthored = (world: World): AuthoredEnvelope | undefined => {
  const author = world.localAgent.did

  const collapsed = new Map<string, AuthoredEvent>()
  for (let i = world.authoredCursor; i < world.eventLog.length; i++) {
    const event = world.eventLog[i]
    if (event.author !== author) continue
    const key = `${event.entityPath.join('/')}|${event.predicate}`
    collapsed.set(key, event)
  }
  world.authoredCursor = world.eventLog.length
  const events = Array.from(collapsed.values())

  const now = world.engine.clock.now()
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
  }
  world.destroyQueue.length = 0

  if (events.length === 0) return undefined

  const envelope: AuthoredEnvelope = { events, fromPeer: author }

  const networks = Array.from(getNetworks(world).values())
  if (networks.length === 1) {
    publishAuthored(world, networks[0], envelope)
  } else if (networks.length > 1) {
    for (const network of networks) {
      publishAuthored(world, network, envelope)
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
  // Broadcast to every network. Spatial segmentation will narrow this.
  for (const network of networks) publishRuntime(world, network, snapshot)
  return snapshot.size === 0 ? undefined : snapshot
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
 *
 * No `withoutAuthoring` wrapper needed: `applyEvent` uses raw ops
 * (`writeComponent`, `writeRelation`, `destroyEntity`), which produce no
 * events. The author field on each event in the log distinguishes local
 * from remote — `flushAuthored` skips non-local events via the cursor.
 */
export const applyAuthoredEnvelope = (world: World, envelope: AuthoredEnvelope): AuthoredEvent[] => {
  const accepted: AuthoredEvent[] = []
  for (const event of envelope.events) {
    if (!validateAuthored(world, event)) continue
    const standing = checkAuthorityChangeStanding(world, event)
    if (standing !== undefined) continue
    if (!appendEventLog(world, event)) continue
    applyEvent(world, event)
    accepted.push(event)
  }
  return accepted
}

const applyEvent = (world: World, event: AuthoredEvent): void => {
  let entity = resolveEntityPath(world, event.entityPath)

  if (event.op === 'destroy') {
    if (entity !== undefined) destroyEntity(world, entity)
    return
  }

  if (entity === undefined) {
    entity = ensureEntityPath(world, event.entityPath)
  }

  const component = getComponentById(event.predicate)
  if (component) {
    if (event.op === 'set') {
      writeComponent(world, entity, component, (event.value ?? {}) as Record<string, unknown>)
    } else if (event.op === 'remove') {
      eraseComponent(world, entity, component)
    }
    return
  }

  const relation = getRelationByName(event.predicate)
  if (relation) {
    const targetPath = (event.value as { targetPath?: string[] } | null)?.targetPath
    if (!targetPath) return
    const target = ensureEntityPath(world, targetPath)
    if (event.op === 'set') writeRelation(world, entity, relation, target)
    else if (event.op === 'remove') eraseRelation(world, entity, relation, target)
  }
}
