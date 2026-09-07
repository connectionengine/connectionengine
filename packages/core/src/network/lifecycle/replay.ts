/**
 * Join-time catch-up. It has two halves. Both stream over the ordered `events`
 * channel, before the live traffic starts.
 *
 * 1. **Event-log replay** (`streamEventLog`) — the authored events of the host,
 *    from the cursor of the joiner onwards, in ordered chunks. The receiver
 *    applies each event with `origin='network'`, through the standard
 *    `applyAuthoredEnvelope` path, which is itself idempotent through
 *    `appendEventLog`. This half reconstructs history: the existence of every
 *    component, and the state that it was created with.
 * 2. **State snapshot** (`streamStateSnapshot`) — a point-in-time capture of
 *    every named entity, and of *all* of its components, whatever their
 *    channel. This half carries the *current* continuous state. Motion never
 *    authors, so replay can reproduce only the pose that a component was
 *    created with. The binary delta channel sends only the entities that are
 *    currently dirty, which leaves an entity at rest stale by however far it
 *    has moved.
 *
 * Replay goes first, and the snapshot goes last: history, then the present. The
 * opposite order would let a replayed creation event overwrite the newer
 * snapshot. Both halves apply idempotent sets, and neither one emits again,
 * because everything applies with `origin='network'`.
 */

import type { AuthoredEvent, World } from '../../ecs/world'
import type { TransportEndpoint } from '../transport'
import type { Network } from '../network'
import { applyAuthoredEnvelope } from '../mutation'
import { applySnapshot, createSnapshot, type Snapshot } from '../snapshot'

export interface ReplayChunkMessage {
  type: 'replay-chunk'
  events: AuthoredEvent[]
}

export interface ReplayEndMessage {
  type: 'replay-end'
  totalEvents: number
}

export interface SnapshotMessage {
  type: 'snapshot'
  snapshot: Snapshot
}

export const DEFAULT_REPLAY_CHUNK = 256

/**
 * Send the local world state to a peer that has just joined. The function
 * returns false, and sends nothing, when the world holds no addressable state
 * to send.
 */
export const streamStateSnapshot = (world: World, endpoint: TransportEndpoint): boolean => {
  const snapshot = createSnapshot(world)
  if (snapshot.entities.length === 0) return false
  endpoint.events.send({ type: 'snapshot', snapshot } satisfies SnapshotMessage)
  return true
}

/** Mark the end of the catch-up phase. The joiner resolves its join on this
 *  marker. */
export const endReplay = (world: World, endpoint: TransportEndpoint): void => {
  endpoint.events.send({ type: 'replay-end', totalEvents: world.eventLog.length } satisfies ReplayEndMessage)
}

/**
 * Apply a bootstrap snapshot that arrived from `fromPeer`. The function merges,
 * and never clears the local state. It admits each write through the same gates
 * that an authored event from that peer must pass.
 */
export const applyStateSnapshot = (world: World, snapshot: Snapshot, fromPeer: string, network?: Network): number => {
  applySnapshot(world, snapshot, { from: { author: fromPeer, network } })
  return snapshot.entities.length
}

/**
 * Stream the eventLog of the host over an endpoint, from `fromIndex` onwards,
 * as ordered chunks. The function does **not** send `replay-end`. The caller
 * owns that marker, because the state snapshot must land between the last chunk
 * and the end of the catch-up phase.
 */
export const streamEventLog = (
  world: World,
  endpoint: TransportEndpoint,
  fromIndex: number,
  chunkSize = DEFAULT_REPLAY_CHUNK
): void => {
  const events = world.eventLog.slice(fromIndex)
  for (let i = 0; i < events.length; i += chunkSize) {
    endpoint.events.send({
      type: 'replay-chunk',
      events: events.slice(i, i + chunkSize)
    } satisfies ReplayChunkMessage)
  }
}

/** Apply one replay chunk to the world. The function returns the number of
 *  events that it applied for the first time. */
export const applyReplayChunk = (
  world: World,
  fromPeer: string,
  events: readonly AuthoredEvent[],
  network?: Network
): number => {
  const before = world.eventLog.length
  applyAuthoredEnvelope(world, { fromPeer, events: events.slice() }, network)
  return world.eventLog.length - before
}
