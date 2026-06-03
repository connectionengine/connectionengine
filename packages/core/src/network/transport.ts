/**
 * Transport — abstract endpoint contract + in-memory implementation.
 *
 * `TransportEndpoint` is the wire-mechanism abstraction: how bytes get from
 * one peer to another. WebRTC DataChannels, WebSockets, and the in-memory
 * channel below all satisfy it. The session protocol (handshake, event-log
 * replay, peer entity bookkeeping) lives one layer up in `lifecycle.ts`.
 *
 * Existing `connectInMemory(worldA, worldB)` is preserved as a convenience
 * shortcut for tests that want both worlds pre-wired without going through
 * the formal join protocol.
 */

import type { AuthoredEnvelope, AuthoredEvent, Connection, RuntimeEnvelope, World } from '../ecs/world'
import type { ComponentDefinition } from '../ecs/component'
import { applyAuthoredEnvelope, applyRuntimeEnvelope } from '../engine/mutation'

export type TransportBackend = 'webrtc' | 'websocket' | 'memory'

// ── Endpoint contract ────────────────────────────────────────────────────────-

/**
 * A bi-directional binary channel to one remote peer. Real backends produce
 * one endpoint per remote; the in-memory factory below produces a pair.
 *
 * Payload type is `unknown` because in-memory channels can pass JS objects
 * directly (no serialisation cost) while wire transports send `ArrayBuffer`
 * — the engine codec (`engine/codec.ts`) is the bridge between them.
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
 * after a microtask (or the configured `latencyMs`). Use as the wire layer
 * under `joinWorld` for same-process two-peer tests.
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
 * Per-runtime-component transport tuning. Wire into `world.network.runtimeConfig`
 * (see lifecycle.ts) to control flush cadence + full-sync intervals + receive-side
 * interpolation per component id.
 *
 * The engine itself doesn't currently throttle flushes per-component — every
 * `runSystems` call ships dirty runtime state. This config is the slot where
 * a future bandwidth-aware scheduler hooks in (deferred work).
 */
export interface RuntimeTransportConfig {
  /** Component IDs this config applies to. */
  componentIds: string[]
  /** Target tick rate in Hz. Default 60. */
  rate?: number
  /**
   * Ticks between full state syncs (vs deltas only). Provides convergence
   * after packet loss. Default 300 (~5s at 60Hz).
   */
  fullSyncInterval?: number
  /** Whether receivers should interpolate between updates. Default true. */
  interpolation?: boolean
}

/** Resolve config for a specific component. Used by transports that throttle. */
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

// ── Convenience shortcut (existing API; lifecycle.ts is the formal path) ──────

export interface MemoryConnectionPair {
  a: Connection
  b: Connection
  close(): void
}

export interface ConnectInMemoryOptions {
  validate?: (world: World, event: AuthoredEvent) => boolean
  latencyMs?: number
}

type Envelope = AuthoredEnvelope | RuntimeEnvelope
const isAuthored = (e: Envelope): e is AuthoredEnvelope => Array.isArray((e as AuthoredEnvelope).events)

/**
 * Pre-wire two worlds over an in-memory channel without going through the
 * formal join handshake. Useful for tests that don't need late-join semantics.
 * For real session lifecycle (handshake + event-log replay + disconnect
 * cleanup), use `createMemoryTransport` + `joinWorld` instead.
 */
export const connectInMemory = (
  worldA: World,
  worldB: World,
  options: ConnectInMemoryOptions = {}
): MemoryConnectionPair => {
  if (options.validate) {
    const v = options.validate
    if (!worldA.network.validateAuthored) worldA.network.validateAuthored = (e) => v(worldA, e)
    if (!worldB.network.validateAuthored) worldB.network.validateAuthored = (e) => v(worldB, e)
  }

  const deliver = (target: World, envelope: Envelope): void => {
    const dispatch = () => {
      if (isAuthored(envelope)) applyAuthoredEnvelope(target, envelope)
      else applyRuntimeEnvelope(target, envelope)
    }
    if (options.latencyMs && options.latencyMs > 0) setTimeout(dispatch, options.latencyMs)
    else queueMicrotask(dispatch)
  }

  const a: Connection = {
    peer: 0,
    backend: 'memory',
    send: (payload) => deliver(worldB, payload as Envelope),
    close: () => {
      worldA.network.connections.delete(a)
    }
  }
  const b: Connection = {
    peer: 0,
    backend: 'memory',
    send: (payload) => deliver(worldA, payload as Envelope),
    close: () => {
      worldB.network.connections.delete(b)
    }
  }

  worldA.network.connections.add(a)
  worldB.network.connections.add(b)
  installFanout(worldA)
  installFanout(worldB)

  return {
    a,
    b,
    close: () => {
      a.close()
      b.close()
    }
  }
}

const installedFanout = new WeakSet<World>()
const installFanout = (world: World): void => {
  if (installedFanout.has(world)) return
  installedFanout.add(world)
  world.network.publishAuthored = (envelope) => {
    for (const conn of world.network.connections) conn.send(envelope)
  }
  world.network.publishRuntime = (envelope) => {
    for (const conn of world.network.connections) conn.send(envelope)
  }
}

/** Test helper: drain the microtask queue so queued receives land. */
export const flushAsync = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve))
