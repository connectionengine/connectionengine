/**
 * Transport — abstract endpoint contract + in-memory implementation +
 * per-component runtime config.
 *
 * `TransportEndpoint` is the wire-mechanism abstraction: how bytes get from
 * one peer to another. WebRTC DataChannels, WebSockets, and the in-memory
 * channel below all satisfy it. Session protocol (handshake, replay,
 * bookkeeping) lives in `lifecycle/` one layer up.
 *
 * `connectInMemory(a, b)` is the test/solo-mode shortcut: pre-wires two
 * worlds without going through the formal handshake — useful when you just
 * want envelope-level fanout between worlds in-process.
 */

import type { ComponentDefinition } from '../ecs/component'

export type TransportBackend = 'webrtc' | 'websocket' | 'memory'

// ── Endpoint contract ────────────────────────────────────────────────────────-

/**
 * A bi-directional channel to one remote peer. Real backends produce one
 * endpoint per remote; the in-memory factory below produces a pair.
 *
 * Payload type is `unknown`: control + authored envelopes pass as plain JS
 * objects in-process, runtime packets pass as `ArrayBuffer`. The lifecycle
 * layer discriminates by shape.
 */
export interface TransportEndpoint {
  readonly backend: TransportBackend
  send(payload: unknown): void
  onMessage(handler: (payload: unknown) => void): () => void
  onClose(handler: () => void): () => void
  close(): void
}

export interface MemoryTransportPair {
  a: TransportEndpoint
  b: TransportEndpoint
  /** Close both endpoints. */
  close(): void
}

export interface MemoryTransportOptions {
  /** Optional simulated latency in ms (default: queueMicrotask). */
  latencyMs?: number
}

/**
 * Create a paired in-memory transport. Each endpoint delivers to the other
 * after a microtask (or `latencyMs` if set). Use as the wire layer under
 * `joinWorld` for same-process two-peer tests.
 */
export const createMemoryTransport = (options: MemoryTransportOptions = {}): MemoryTransportPair => {
  const aListeners = { msg: new Set<(p: unknown) => void>(), close: new Set<() => void>() }
  const bListeners = { msg: new Set<(p: unknown) => void>(), close: new Set<() => void>() }
  let closed = false

  const deliver = (to: typeof aListeners, payload: unknown): void => {
    if (closed) return
    const dispatch = () => {
      for (const h of to.msg) h(payload)
    }
    if (options.latencyMs && options.latencyMs > 0) setTimeout(dispatch, options.latencyMs)
    else queueMicrotask(dispatch)
  }

  const closeAll = (): void => {
    if (closed) return
    closed = true
    for (const h of aListeners.close) h()
    for (const h of bListeners.close) h()
    aListeners.msg.clear()
    bListeners.msg.clear()
    aListeners.close.clear()
    bListeners.close.clear()
  }

  const mkEndpoint = (self: typeof aListeners, peer: typeof aListeners): TransportEndpoint => ({
    backend: 'memory',
    send: (payload) => deliver(peer, payload),
    onMessage: (h) => {
      self.msg.add(h)
      return () => self.msg.delete(h)
    },
    onClose: (h) => {
      self.close.add(h)
      return () => self.close.delete(h)
    },
    close: closeAll
  })

  return {
    a: mkEndpoint(aListeners, bListeners),
    b: mkEndpoint(bListeners, aListeners),
    close: closeAll
  }
}

// ── Per-component runtime transport configuration ────────────────────────────-

/**
 * Per-runtime-component transport tuning. Consumed by per-connection binary
 * channels (`lifecycle/binary-channel.ts`) to throttle outbound publishes
 * + schedule periodic full-state snapshots.
 */
export interface RuntimeTransportConfig {
  /** Component IDs this config applies to. */
  componentIds: string[]
  /** Target tick rate in Hz (assuming a 60Hz tick budget). Default 60. */
  rate?: number
  /**
   * Ticks between full state syncs (vs deltas only). Provides convergence
   * after packet loss. Default 300 (~5s at 60Hz).
   */
  fullSyncInterval?: number
  /** Whether receivers should interpolate between updates. Default true. */
  interpolation?: boolean
}

/** Resolve config for a specific component. */
export const resolveRuntimeConfig = (
  configs: RuntimeTransportConfig[],
  component: ComponentDefinition
): Required<RuntimeTransportConfig> => {
  const match = configs.find((c) => c.componentIds.includes(component.id))
  return {
    componentIds: [component.id],
    rate: match?.rate ?? 60,
    fullSyncInterval: match?.fullSyncInterval ?? 300,
    interpolation: match?.interpolation ?? true
  }
}

/** Test helper: drain the microtask queue so queued receives land. */
export const flushAsync = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve))
