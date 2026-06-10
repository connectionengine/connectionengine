/**
 * Event-log replay — host streams its authored events to a freshly-joining
 * peer in ordered chunks. The receiver applies each with `origin='network'`
 * via the standard `applyAuthoredEnvelope` path (which is itself idempotent
 * via `appendEventLog`).
 */

import type { AuthoredEvent, World } from '../../ecs/world'
import type { TransportEndpoint } from '../transport'
import type { Network } from '../network'
import { applyAuthoredEnvelope } from '../mutation'

export interface ReplayChunkMessage {
  type: 'replay-chunk'
  events: AuthoredEvent[]
}

export interface ReplayEndMessage {
  type: 'replay-end'
  totalEvents: number
}

export const DEFAULT_REPLAY_CHUNK = 256

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
