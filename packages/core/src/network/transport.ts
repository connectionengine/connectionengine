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

// ── Endpoint contract ────────────────────────────────────────────────────────-

/**
 * A single uni-typed pub/sub channel. One transport endpoint carries two of
 * them, with different delivery semantics — see `TransportEndpoint`.
 */
export interface TransportChannel<T = unknown> {
  send(payload: T): void
  onMessage(handler: (payload: T) => void): () => void
}

/**
 * A bi-directional link to one remote peer, exposing two separately-shaped
 * channels:
 *
 *   - **`events`** — reliable, ordered. Carries control messages (hello,
 *     replay, leave, bind) and authored envelopes (`{ events, fromPeer }`).
 *     Map to TCP / WebSocket / a reliable QUIC stream / an ordered+reliable
 *     WebRTC `RTCDataChannel`.
 *
 *   - **`stream`** — `ArrayBuffer`-only, typically unreliable / unordered,
 *     optimised for cadence over delivery guarantees. Carries the binary
 *     runtime packets emitted by the per-connection `BinaryChannel`. Map to
 *     QUIC datagrams / an unordered+unreliable WebRTC data channel.
 *
 * Concrete implementations (WebRTC, WebSocket, in-memory, AD4M Perspective,
 * QUIC) decide what underlying mechanism backs each channel. A transport
 * with only one wire (WebSocket-only) can satisfy both slots with the same
 * underlying connection — it just doesn't get the loss-tolerance win.
 */
export interface TransportEndpoint {
  readonly events: TransportChannel
  readonly stream: TransportChannel<ArrayBuffer>
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
 * after a microtask (or `latencyMs` if set). Both `events` and `stream`
 * channels are fully reliable in-process — the dual surface exists so the
 * lifecycle layer reads the same on real wire transports.
 */
export const createMemoryTransport = (options: MemoryTransportOptions = {}): MemoryTransportPair => {
  type Side<T> = { msg: Set<(p: T) => void> }
  type Pair = {
    events: Side<unknown>
    stream: Side<ArrayBuffer>
    close: Set<() => void>
  }
  const aListeners: Pair = { events: { msg: new Set() }, stream: { msg: new Set() }, close: new Set() }
  const bListeners: Pair = { events: { msg: new Set() }, stream: { msg: new Set() }, close: new Set() }
  let closed = false

  const dispatch = <T>(side: Side<T>, payload: T): void => {
    if (closed) return
    const fire = () => {
      for (const h of side.msg) h(payload)
    }
    if (options.latencyMs && options.latencyMs > 0) setTimeout(fire, options.latencyMs)
    else queueMicrotask(fire)
  }

  const mkChannel = <T>(peer: Side<T>, self: Side<T>): TransportChannel<T> => ({
    send: (payload) => dispatch(peer, payload),
    onMessage: (h) => {
      self.msg.add(h)
      return () => self.msg.delete(h)
    }
  })

  const closeAll = (): void => {
    if (closed) return
    closed = true
    for (const h of aListeners.close) h()
    for (const h of bListeners.close) h()
    aListeners.events.msg.clear()
    aListeners.stream.msg.clear()
    bListeners.events.msg.clear()
    bListeners.stream.msg.clear()
    aListeners.close.clear()
    bListeners.close.clear()
  }

  const mkEndpoint = (self: Pair, peer: Pair): TransportEndpoint => ({
    events: mkChannel<unknown>(peer.events, self.events),
    stream: mkChannel<ArrayBuffer>(peer.stream, self.stream),
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
