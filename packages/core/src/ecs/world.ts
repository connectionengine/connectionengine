/**
 * World — top-level ECS container.
 *
 * Holds time state, network bindings (opaque agent, schema registry, transport
 * publish hooks), entity identity caches (BelongsTo → uid → child), the
 * per-world authored mutation queue + event log, the runtime dirty-flag set,
 * and the structured trace sink. Multiple worlds coexist; nothing global.
 *
 * Core is identity- and crypto-agnostic. The local `Agent` is opaque — its
 * `did` is just a string from the engine's perspective; the `sign` hook is
 * optional and only invoked by the runtime mode (e.g. @connectionengine/local
 * adds Ed25519 signing on the wire, @connectionengine/ad4m-bridge wraps in
 * AD4M Expressions).
 */

import * as bitecs from 'bitecs'
import type { Clock } from './clock'
import { wallClock } from './clock'
import type { TraceSink } from './trace'
import { createTraceSink } from './trace'

export type Entity = number

// ── Agent (opaque local identity) ────────────────────────────────────────────

/**
 * Local agent identity. Engine treats `did` as an opaque string; `sign` is
 * optional and only used by runtime modes that need to sign outbound events.
 *
 * For solo mode (no transport, no peers) the agent can be a minimal stub
 * (e.g. `{ did: 'did:anon:abc' }`). For real identity, use
 * @connectionengine/local (Ed25519/did:key) or @connectionengine/ad4m-bridge
 * (AD4M Agent).
 */
export interface Agent {
  readonly did: string
  /** Optional sign hook. Runtime modes that wrap outbound events provide this. */
  sign?: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>
}

// ── Authored events (engine-level, unsigned) ─────────────────────────────────-

/**
 * An authored mutation, in engine form. No signature, no proof — those are
 * the runtime mode's concern at the transport boundary.
 */
export interface AuthoredEvent {
  entityPath: string[]
  predicate: string
  op: 'set' | 'remove' | 'spawn' | 'destroy'
  value: unknown
  /** Author DID (string). Attached by `flushAuthored` for local events; carried verbatim for received events. */
  author: string
  /** ms since epoch. Attached by `flushAuthored` from the world clock. */
  timestamp: number
}

/** Wire-shape envelope of authored events from one peer. */
export interface AuthoredEnvelope {
  events: AuthoredEvent[]
  fromPeer: string
}

// ── Queue + connection types ─────────────────────────────────────────────────-

/** A queued local mutation awaiting end-of-tick path-resolution + publish. */
export interface QueuedAuthored {
  entity: Entity
  predicate: string
  op: 'set' | 'remove' | 'spawn' | 'destroy'
  value: unknown
  /** Origin: 'local' goes outbound; 'network' is suppressed (received). */
  origin: 'local' | 'network'
}

/** Dirty marker for runtime components. */
export interface DirtyKey {
  entity: Entity
  componentId: string
}

/**
 * A live transport link to a peer. A Connection is a `TransportEndpoint` plus
 * session-level metadata (remoteDID, local peer entity once known).
 *
 * Wire payloads are typed by JS shape:
 *   - `ArrayBuffer`  → binary runtime packet (decoded by the binary pipeline)
 *   - `{ events }`   → AuthoredEnvelope (low-frequency reliable channel)
 *   - `{ type: ... }` → control message (handshake, replay, leave, bind)
 */
export interface Connection {
  peer: Entity
  backend: 'webrtc' | 'websocket' | 'memory'
  /** Remote agent DID — `'did:unknown:pending'` until the hello is received. */
  remoteDID: string
  send(payload: unknown): void
  onMessage(handler: (payload: unknown) => void): () => void
  onClose(handler: () => void): () => void
  close(): void
}

export interface NetworkBindings {
  /** Active peer connections for this world's live session. */
  connections: Set<Connection>
  /** Component id → ComponentSchema (shareable metadata). */
  schemas: Map<string, import('./component').ComponentSchema>
  /** Local agent — opaque to core. Required. */
  localAgent: Agent
  /** Local peer entity (set on createPeer for this runtime). */
  localPeer?: Entity
  /** Governance constraint registry — populated by network/governance.ts. */
  constraints: Map<Entity, unknown>
  /**
   * Outbound publish hook for authored envelopes. Runtime mode wires this
   * (local mode signs, ad4m mode wraps in Expression, in-memory fans out raw).
   * Engine calls it at end-of-tick.
   */
  publishAuthored?: (envelope: AuthoredEnvelope) => void
  /**
   * Outbound publish hook for runtime mutations — receives the dirty map
   * directly (componentId → entities that changed). The network layer
   * encodes via the binary pipeline + ships per-connection.
   */
  publishRuntime?: (dirty: Map<string, Set<Entity>>) => void
  /**
   * Inbound governance gate. Runtime mode wires this; called per received
   * authored event before apply. Returning false drops the event.
   */
  validateAuthored?: (event: AuthoredEvent) => boolean
}

export interface World extends bitecs.World {
  // Time
  frameTime: number
  simulationTime: number
  fixedTimeStep: number
  deltaSeconds: number
  accumulator: number

  // Realtime
  network: NetworkBindings

  // Identity caches — populated by setUID + entity removal hook
  /** parent entity → (uid → child entity) */
  nameCache: Map<Entity, Map<string, Entity>>
  /** child entity → parent entity (reverse for unlink + path walking) */
  parentOf: Map<Entity, Entity>
  /** entity → uid (reverse for path walking + cache invalidation) */
  uidOf: Map<Entity, string>

  // Mutation pipeline state
  authoredQueue: QueuedAuthored[]
  /** Append-only canonical event log — plain AuthoredEvent (no signatures). */
  eventLog: AuthoredEvent[]
  /**
   * Composite-key index of events present in `eventLog`. Used by every append
   * path (local flush, network apply, replay) to make appends idempotent —
   * duplicates of an already-recorded event are dropped silently. Signature
   * is composed of (author, timestamp, op, predicate, entityPath, value).
   */
  eventLogSeen: Set<string>
  /** Runtime dirty set — written by setComponent on runtime-category components. */
  runtimeDirty: Map<string, Set<Entity>>

  // Infrastructure
  clock: Clock
  trace: TraceSink
}

export const Worlds = new Set<World>()

export interface CreateWorldOptions {
  /** Local agent identity. Required — runtime modes provide a real agent;
   *  solo callers can pass a stub `{ did: 'did:anon:xxx' }`. */
  agent: Agent
  /** Simulation tick rate in seconds. Default 1/60. */
  fixedTimeStep?: number
  /** Injectable clock — defaults to wall-clock. Tests pass a manual clock. */
  clock?: Clock
  /** Trace sink — defaults to an in-memory recording sink. */
  trace?: TraceSink
}

export const createWorld = (options: CreateWorldOptions): World => {
  const world = bitecs.createWorld() as World
  world.frameTime = 0
  world.simulationTime = 0
  world.fixedTimeStep = options.fixedTimeStep ?? 1 / 60
  world.deltaSeconds = 0
  world.accumulator = 0
  world.network = {
    connections: new Set(),
    schemas: new Map(),
    localAgent: options.agent,
    constraints: new Map()
  }
  world.nameCache = new Map()
  world.parentOf = new Map()
  world.uidOf = new Map()
  world.authoredQueue = []
  world.eventLog = []
  world.eventLogSeen = new Set()
  world.runtimeDirty = new Map()
  world.clock = options.clock ?? wallClock
  world.trace = options.trace ?? createTraceSink()
  Worlds.add(world)
  return world
}

export const destroyWorld = (world: World): void => {
  // Idempotent: skip if already destroyed.
  if (!Worlds.has(world)) return
  for (const conn of world.network.connections) conn.close()
  world.network.connections.clear()
  world.network.schemas.clear()
  world.nameCache.clear()
  world.parentOf.clear()
  world.uidOf.clear()
  world.authoredQueue.length = 0
  world.eventLog.length = 0
  world.eventLogSeen.clear()
  world.runtimeDirty.clear()
  bitecs.resetWorld(world)
  bitecs.deleteWorld(world)
  Worlds.delete(world)
}

// ── Time loop ─────────────────────────────────────────────────────────────────

/**
 * Step the world's time state by one frame.
 *
 * Decoupled from the requestAnimationFrame loop so tests can drive time
 * deterministically. `runSystems` is invoked once per fixed-timestep substep
 * for Simulation phase systems, and once per frame for variable-step phases.
 */
export const tickWorld = (
  world: World,
  deltaSeconds: number,
  systems: { fixed: () => void; variable: () => void }
): void => {
  world.deltaSeconds = deltaSeconds
  world.frameTime += deltaSeconds * 1000
  world.accumulator += deltaSeconds

  // Fixed-timestep substeps
  let safety = 0
  while (world.accumulator >= world.fixedTimeStep && safety++ < 256) {
    world.simulationTime += world.fixedTimeStep
    world.accumulator -= world.fixedTimeStep
    systems.fixed()
  }
  systems.variable()
}

// ── Stub agent (for solo + tests) ────────────────────────────────────────────

/**
 * A minimal anonymous agent. Useful for solo-mode worlds and tests that don't
 * need real identity. Generates a random "did:anon:{nonce}" DID. The `sign`
 * hook is intentionally absent — calling code that needs signing must provide
 * a real agent (from @connectionengine/local or @connectionengine/ad4m-bridge).
 */
export const createAnonAgent = (seed?: string): Agent => {
  const nonce = seed ?? Math.random().toString(36).slice(2, 12)
  return { did: `did:anon:${nonce}` }
}
