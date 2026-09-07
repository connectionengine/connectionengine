/**
 * Join-time catch-up — two halves, both streamed over the ordered `events`
 * channel before live traffic starts.
 *
 * 1. **Event-log replay** (`streamEventLog`) — the host's authored events from
 *    the joiner's cursor onwards, in ordered chunks. The receiver applies each
 *    with `origin='network'` via the standard `applyAuthoredEnvelope` path
 *    (itself idempotent via `appendEventLog`). This reconstructs history: every
 *    component's existence, and the state it was created with.
 * 2. **State snapshot** (`streamStateSnapshot`) — a point-in-time capture of
 *    every named entity and *all* of its components, regardless of channel.
 *    This is what carries *current* continuous state. Motion never authors, so
 *    replay can only ever reproduce the pose a component was created with, and
 *    the binary delta channel only ships entities that are currently dirty —
 *    leaving an entity at rest stale by however far it has moved.
 *
 * Replay goes first, snapshot last: history, then present. The reverse order
 * would let a replayed creation event clobber the newer snapshot. Both are
 * idempotent sets and neither re-emits — everything applies with
 * `origin='network'`.
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
 * Send the local world state to a freshly-joining peer. Returns false (and
 * sends nothing) when there is no addressable state to ship.
 */
export const streamStateSnapshot = (world: World, endpoint: TransportEndpoint): boolean => {
  const snapshot = createSnapshot(world)
  if (snapshot.entities.length === 0) return false
  endpoint.events.send({ type: 'snapshot', snapshot } satisfies SnapshotMessage)
  return true
}

/** Mark the end of the catch-up phase; the joiner resolves its join on this. */
export const endReplay = (world: World, endpoint: TransportEndpoint): void => {
  endpoint.events.send({ type: 'replay-end', totalEvents: world.eventLog.length } satisfies ReplayEndMessage)
}

/**
 * Apply a bootstrap snapshot received from `fromPeer`. Merges — never clears
 * local state — and admits each write through the same gates an authored event
 * from that peer would face.
 */
export const applyStateSnapshot = (world: World, snapshot: Snapshot, fromPeer: string, network?: Network): number => {
  applySnapshot(world, snapshot, { from: { author: fromPeer, network } })
  return snapshot.entities.length
}

/**
 * Stream the host's eventLog (from `fromIndex` onwards) over an endpoint as
 * ordered chunks. Does **not** send `replay-end` — the caller owns that marker,
 * because the state snapshot has to land between the last chunk and the end of
 * the catch-up phase.
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

/** Apply one replay chunk to the world; returns how many events were newly applied. */
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
