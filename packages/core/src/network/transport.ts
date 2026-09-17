/**
 * Transport — the abstract endpoint contract, the in-memory implementation, and
 * the per-component runtime config.
 *
 * `TransportEndpoint` abstracts the wire mechanism, which moves bytes from one
 * peer to another. WebRTC DataChannels, WebSockets, and the in-memory channel
 * below all satisfy it. The session protocol — handshake, replay, and
 * bookkeeping — lives one layer up, in `lifecycle/`.
 *
 * `createMemoryTransport()` here returns a paired endpoint for tests. For the
 * test and solo-mode shortcut that links two worlds without the formal
 * handshake, see `connectInMemory(a, b)` in `testing/connect-memory.ts`. Use
 * it when you need only envelope-level fanout between worlds in one process.
 */

import type { ComponentDefinition } from '../ecs/component'

// ── Endpoint contract ────────────────────────────────────────────────────────-

/**
 * One uni-typed pub/sub channel. Each transport endpoint carries two of them,
 * with different delivery semantics. See `TransportEndpoint`.
 */
export interface TransportChannel<T = unknown> {
  send(payload: T): void
  onMessage(handler: (payload: T) => void): () => void
}

/**
 * A bi-directional link to one remote peer. It exposes two channels with
 * different shapes:
 *
 *   - **`events`** — reliable and ordered. It carries the control messages
 *     (hello, replay, leave, bind) and the authored envelopes
 *     (`{ events, fromPeer }`). Map it to TCP, to a WebSocket, to a reliable
 *     QUIC stream, or to an ordered and reliable WebRTC `RTCDataChannel`.
 *
 *   - **`stream`** — `ArrayBuffer` only. It is typically unreliable and
 *     unordered, and it favours cadence over delivery guarantees. It carries
 *     the binary runtime packets that the per-connection `BinaryChannel`
 *     emits. Map it to QUIC datagrams, or to an unordered and unreliable
 *     WebRTC data channel.
 *
 * Each concrete implementation — WebRTC, WebSocket, in-memory, AD4M
 * Perspective, or QUIC — decides which mechanism backs each channel. A
 * transport with only one wire, such as a WebSocket-only transport, can fill
 * both slots from the same underlying connection. It does not gain the
 * loss-tolerance benefit.
 */
export interface TransportEndpoint {
  readonly events: TransportChannel
  readonly stream: TransportChannel<ArrayBuffer>
  onClose(handler: () => void): () => void
  close(): void
}

/**
 * What a connection does with its binary delta channel: send the dirty set,
 * take an inbound packet, take an inbound networkId binding.
 *
 * Structural, so `transport.ts` stays a leaf. `BinaryChannel` satisfies it
 * without either module importing the other, which is what lets `network.ts`
 * publish through a connection while `lifecycle/` builds the channel.
 */
export interface RuntimeChannel {
  publish(dirty: Map<string, Set<number>>): void
  applyBuffer(buffer: ArrayBuffer): void
  registerBindings(bindings: readonly { networkId: number; entityPath: string[] }[]): void
}

/**
 * A live link to one remote peer, scoped to ONE Network.
 *
 * It lives here rather than in `network.ts` because it is a transport concept:
 * a pair of `TransportChannel`s plus the session metadata that identifies who
 * is on the other end. Keeping it here also lets `network.ts` reach the binary
 * channel without the two modules importing each other.
 *
 * Two peers can hold several Connections between them, one for each Network
 * they share. Whether those share an underlying transport is the business of
 * the transport, and the engine does not track it.
 */
export interface Connection {
  /** Peer entity for the remote end. Zero until the handshake identifies it. */
  peer: number
  /** Remote agent DID. Undefined until the hello arrives. */
  remoteDID?: string
  readonly events: TransportChannel
  readonly stream: TransportChannel<ArrayBuffer>
  /** Binary delta channel for this connection. Set when the connection is
   *  wired, so the publish path never has to build one lazily. */
  channel?: RuntimeChannel
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
  /** Optional simulated latency, in milliseconds. It defaults to a
   *  queueMicrotask delivery. */
  latencyMs?: number
}

/**
 * Create a paired in-memory transport. Each endpoint delivers to the other
 * after one microtask, or after `latencyMs` when the caller sets it. In one
 * process, the `events` channel and the `stream` channel are both fully
 * reliable. The two-channel surface exists so that the lifecycle layer reads
 * the same way on a real wire transport.
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
 * Transport tuning for one runtime component. The per-connection binary
 * channels in `lifecycle/binary-channel.ts` read it. They use it to throttle
 * the outbound publishes, and to schedule the periodic full-state snapshots.
 */
export interface RuntimeTransportConfig {
  /** The component IDs that this config applies to. */
  componentIds: string[]
  /** Target publish rate, in Hz. It defaults to the simulation tick rate, which
   *  applies no throttle. */
  rate?: number
  /** Ticks between two full state syncs, as opposed to deltas alone. A full
   *  sync restores convergence after packet loss. It defaults to 300. */
  fullSyncInterval?: number
}

/**
 * Resolve the config for one component. `simRate` is the simulation tick rate
 * in Hz, which equals `1 / world.engine.fixedTimeStep`. It supplies the default
 * for `rate` when the caller gives no override.
 */
export const resolveRuntimeConfig = (
  configs: RuntimeTransportConfig[],
  component: ComponentDefinition,
  simRate: number
): Required<RuntimeTransportConfig> => {
  const match = configs.find((c) => c.componentIds.includes(component.$id))
  return {
    componentIds: [component.$id],
    rate: match?.rate ?? simRate,
    fullSyncInterval: match?.fullSyncInterval ?? 300
  }
}

/** Test helper. It drains the microtask queue, so that the queued receives
 *  complete. */
export const flushAsync = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve))
