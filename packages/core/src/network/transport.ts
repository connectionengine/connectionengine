/**
 * Transport — in-memory passthrough (no crypto).
 *
 * Wires two worlds together over an in-memory channel. The engine emits
 * AuthoredEnvelope / RuntimeEnvelope via `world.network.publishAuthored?.()` /
 * `publishRuntime?.()`; this transport routes those envelopes directly to the
 * peer world's `applyAuthoredEnvelope` / `applyRuntimeEnvelope`.
 *
 * No signing, no verification — that's a runtime-mode concern. This transport
 * is the "trust the local process" baseline for tests and solo mode.
 * @connectionengine/local wraps it with Ed25519 signing on the wire;
 * @connectionengine/ad4m-bridge replaces it entirely with AD4M Languages.
 *
 * Maps to canonical doc §3.16 (Network Topology) — transport semantics.
 */

import type { AuthoredEnvelope, AuthoredEvent, Connection, RuntimeEnvelope, World } from '../ecs/world'
import { applyAuthoredEnvelope, applyRuntimeEnvelope } from '../engine/mutation'

export type TransportBackend = 'webrtc' | 'websocket' | 'memory'

export interface MemoryConnectionPair {
  /** Connection registered on world A — calling .send delivers to world B's apply path. */
  a: Connection
  /** Connection registered on world B — calling .send delivers to world A's apply path. */
  b: Connection
  /** Disconnect both ends. */
  close(): void
}

export interface MemoryTransportOptions {
  /** Optional governance gate applied per authored event on both directions. */
  validate?: (world: World, event: AuthoredEvent) => boolean
  /** Optional latency simulation in ms (queueMicrotask if undefined or 0). */
  latencyMs?: number
}

type Envelope = AuthoredEnvelope | RuntimeEnvelope
const isAuthored = (e: Envelope): e is AuthoredEnvelope => Array.isArray((e as AuthoredEnvelope).events)

/**
 * Wire two worlds together over an in-memory channel.
 *
 * Installs:
 *   - `connections` entries on both worlds
 *   - `publishAuthored` / `publishRuntime` hooks on both worlds (fan-out to
 *     every connection on that world; for the 2-peer case that's just the
 *     sibling)
 *   - per-event `validateAuthored` gate if a `validate` option is provided
 */
export const connectInMemory = (
  worldA: World,
  worldB: World,
  options: MemoryTransportOptions = {}
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

  // Wire publish hooks on each world: fan-out to every connection.
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

/** Test helper: spin the microtask queue so queued receives land. */
export const flushAsync = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve))
