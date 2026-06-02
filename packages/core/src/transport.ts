/**
 * Transport — contract + in-memory implementation.
 *
 * Real WebRTC / WebSocket transports plug into this interface; the foundation
 * layer ships an in-memory transport that lets two worlds in the same Node
 * process exchange authored batches + runtime packets. The contract is the
 * same; the wire format isn't this layer's concern.
 *
 * Maps to canonical doc §3.16 (Network Topology) — transport semantics.
 */

import type { World, Connection } from './world'
import { receivePayload, type TransportPayload, type ReceiveOptions } from './mutation'

export type TransportBackend = 'webrtc' | 'websocket' | 'memory'

export interface MemoryConnectionPair {
  /** Connection registered on world A — calling .send delivers to world B's receive */
  a: Connection
  /** Connection registered on world B — calling .send delivers to world A's receive */
  b: Connection
  /** Disconnect both ends. */
  close(): void
}

export interface MemoryTransportOptions {
  /** Optional governance gate applied to both directions. */
  validate?: (world: World, triple: import('./did').SignedTriple) => boolean
  /** Optional latency simulation in ms (queueMicrotask if undefined). */
  latencyMs?: number
}

/**
 * Wire two worlds together over an in-memory channel. Each world receives the
 * other's payloads via receivePayload after an optional simulated delay.
 *
 * Returns a MemoryConnectionPair; callers must register each connection
 * on the corresponding world's network.connections set (handled here).
 */
export const connectInMemory = (
  worldA: World,
  worldB: World,
  options: MemoryTransportOptions = {}
): MemoryConnectionPair => {
  const recvOptsA: ReceiveOptions = options.validate ? { validate: options.validate } : {}
  const recvOptsB: ReceiveOptions = options.validate ? { validate: options.validate } : {}

  const dispatch = (target: World, payload: TransportPayload, opts: ReceiveOptions): void => {
    if (options.latencyMs && options.latencyMs > 0) {
      setTimeout(() => receivePayload(target, payload, opts), options.latencyMs)
    } else {
      // Microtask keeps order without forcing arbitrary scheduler latency in tests.
      queueMicrotask(() => receivePayload(target, payload, opts))
    }
  }

  const a: Connection = {
    peer: 0, // peer entities are tier 4 — set externally if needed
    backend: 'memory',
    send: (payload) => dispatch(worldB, payload as TransportPayload, recvOptsB),
    close: () => {
      worldA.network.connections.delete(a)
    }
  }
  const b: Connection = {
    peer: 0,
    backend: 'memory',
    send: (payload) => dispatch(worldA, payload as TransportPayload, recvOptsA),
    close: () => {
      worldB.network.connections.delete(b)
    }
  }

  worldA.network.connections.add(a)
  worldB.network.connections.add(b)

  return {
    a,
    b,
    close: () => {
      a.close()
      b.close()
    }
  }
}

/** Test helper: spin the microtask queue so queued receives land. */
export const flushAsync = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve))
