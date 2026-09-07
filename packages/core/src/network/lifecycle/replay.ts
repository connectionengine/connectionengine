/**
 * Join-time catch-up — two halves, both streamed over the ordered `events`
 * channel before live traffic starts.
 *
 * 1. **State snapshot** (`streamStateSnapshot`) — a point-in-time capture of
 *    every named entity and *all* of its components, regardless of channel.
 *    This is the only bootstrap path for continuous-channel components: they
 *    never enter the event log, and the binary delta channel only ships
 *    entities that are currently dirty, so an entity at rest would otherwise
 *    stay invisible to a late joiner forever.
 * 2. **Event-log replay** (`streamEventLog`) — the host's authored events from
 *    the joiner's cursor onwards, in ordered chunks. The receiver applies each
 *    with `origin='network'` via the standard `applyAuthoredEnvelope` path
 *    (itself idempotent via `appendEventLog`).
 *
 * Snapshot goes first so the joiner has a complete baseline; replay then
 * layers authored history on top and lands on the same state. Both are
 * idempotent sets, so the overlap costs a redundant write, not correctness.
 * Neither re-emits — everything applies with `origin='network'`.
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

/** Apply a received bootstrap snapshot. Merges — never clears local state. */
export const applyStateSnapshot = (world: World, snapshot: Snapshot): number => {
  applySnapshot(world, snapshot)
  return snapshot.entities.length
}

/** Stream the host's eventLog (from `fromIndex` onwards) over an endpoint. */
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
  endpoint.events.send({ type: 'replay-end', totalEvents: world.eventLog.length } satisfies ReplayEndMessage)
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
