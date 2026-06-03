/**
 * World — a logical scope inside an Engine.
 *
 * The bitECS storage (entity ID space, archetype tables, component storage)
 * lives on the Engine — one per process. A World is a structured scope inside
 * that storage: its own root entity (`worldRoot`), its own identity caches,
 * its own time + mutation pipeline, its own networks. Many Worlds coexist in
 * one Engine; entities are partitioned by their `BelongsTo(worldRoot)` chain.
 *
 * Networks are sync topology, not data space — many networks per world for
 * spatial segmentation, voice / video channels, etc. The world's event log is
 * the single canonical history; networks dispatch the same events through
 * different connections.
 */

import * as bitecs from 'bitecs'
import type { Clock } from './clock'
import { wallClock } from './clock'
import type { TraceSink } from './trace'
import { createTraceSink } from './trace'
import type { Engine } from './engine'
import { getDefaultEngine } from './engine'

export type Entity = number

// ── Agent (opaque local identity) ────────────────────────────────────────────

/**
 * Local agent identity. Engine treats `did` as an opaque string; `sign` is
 * optional and only used by runtime modes that need to sign outbound events.
 */
export interface Agent {
  readonly did: string
  /** Optional sign hook. Runtime modes that wrap outbound events provide this. */
  sign?: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>
}

// ── Authored events (engine-level, unsigned) ─────────────────────────────────-

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

export interface QueuedAuthored {
  entity: Entity
  predicate: string
  op: 'set' | 'remove' | 'spawn' | 'destroy'
  value: unknown
  origin: 'local' | 'network'
}

export interface DirtyKey {
  entity: Entity
  componentId: string
}

/**
 * A live transport link to a peer, scoped to ONE Network. A Connection is the
 * pair of channels exposed by the underlying `TransportEndpoint` plus
 * session-level metadata (remoteDID, local peer entity once known).
 *
 *   - `connection.events.send(envelope|controlMessage)` — reliable, ordered.
 *   - `connection.stream.send(arrayBuffer)`             — binary runtime packets.
 *
 * Two peers may have multiple Connections between them — one per Network the
 * pair share. The underlying transport is deduplicated by
 * `engine.peers.acquire()` regardless.
 */
export interface Connection {
  peer: Entity
  /** Remote agent DID — `'did:unknown:pending'` until the hello is received. */
  remoteDID: string
  readonly events: import('../network/transport').TransportChannel
  readonly stream: import('../network/transport').TransportChannel<ArrayBuffer>
  onClose(handler: () => void): () => void
  close(): void
}

// ── Network ──────────────────────────────────────────────────────────────────
//
// The Network *type* lives here so mutation.ts (in engine/) can reference it
// without engine/ → network/ becoming a cycle. The construction helpers
// (addNetwork, ensureDefaultNetwork, removeNetwork) live in
// `network/network.ts`.

/**
 * Sync topology — many per World. A Network owns a connection set, publish
 * hooks, and a governance gate. Different networks can have different
 * delivery + governance semantics layered over the same world's event log.
 */
export interface Network {
  readonly id: string
  /** Active peer connections on this network. */
  readonly connections: Set<Connection>
  /** Outbound publish hook for authored envelopes on this network. */
  publishAuthored?: (envelope: AuthoredEnvelope) => void
  /** Outbound publish hook for runtime mutations on this network. */
  publishRuntime?: (dirty: Map<string, Set<Entity>>) => void
  /** Inbound governance gate. Returning false drops the event. */
  validateAuthored?: (event: AuthoredEvent) => boolean
  /** Close every connection and tear down per-network state. */
  close(): void
}

// ── World ────────────────────────────────────────────────────────────────────

export interface World {
  /** The engine this world belongs to. */
  readonly engine: Engine

  /**
   * Sentinel root entity for this world. Every entity created via
   * `createEntity(world)` is parented to `worldRoot` via `BelongsTo`, giving
   * the world a single subtree to call its own inside the engine's shared
   * bitECS storage.
   */
  readonly worldRoot: Entity

  /** Local agent identity. One per world. */
  localAgent: Agent

  // Time
  frameTime: number
  simulationTime: number
  fixedTimeStep: number
  deltaSeconds: number
  accumulator: number

  // Networks — many per world, keyed by id. A `'default'` network is created
  // automatically; opt into more via `addNetwork(world, spec)`.
  readonly networks: Map<string, Network>

  // Identity caches — populated by setUID + entity removal hook
  /** parent entity → (uid → child entity) */
  nameCache: Map<Entity, Map<string, Entity>>
  /** child entity → parent entity (reverse for unlink + path walking) */
  parentOf: Map<Entity, Entity>
  /** entity → uid (reverse for path walking + cache invalidation) */
  uidOf: Map<Entity, string>

  /** Every entity created via `createEntity(world)` is tracked here for scoped queries + cleanup. */
  readonly entities: Set<Entity>

  // Mutation pipeline state
  authoredQueue: QueuedAuthored[]
  /** Append-only canonical event log — plain AuthoredEvent (no signatures). */
  eventLog: AuthoredEvent[]
  /** Composite-signature index of events present in `eventLog`. Dedup on every push. */
  eventLogSeen: Set<string>
  /** Runtime dirty set — written by setComponent on continuous-channel components. */
  runtimeDirty: Map<string, Set<Entity>>

  // Infrastructure
  clock: Clock
  trace: TraceSink

  /** Local peer entity (set on createPeer for this runtime). */
  localPeer?: Entity
}

export const Worlds = new Set<World>()

export interface CreateWorldOptions {
  /** Local agent identity. Required — runtime modes provide a real agent;
   *  solo callers can pass a stub `{ did: 'did:anon:xxx' }`. */
  agent: Agent
  /** Engine to allocate this world inside. Defaults to the ambient engine. */
  engine?: Engine
  /** Simulation tick rate in seconds. Default 1/60. */
  fixedTimeStep?: number
  /** Injectable clock — defaults to wall-clock. Tests pass a manual clock. */
  clock?: Clock
  /** Trace sink — defaults to an in-memory recording sink. */
  trace?: TraceSink
}

export const createWorld = (options: CreateWorldOptions): World => {
  const engine = options.engine ?? getDefaultEngine()
  const worldRoot = bitecs.addEntity(engine.bitECS)
  const world: World = {
    engine,
    worldRoot,
    localAgent: options.agent,
    frameTime: 0,
    simulationTime: 0,
    fixedTimeStep: options.fixedTimeStep ?? 1 / 60,
    deltaSeconds: 0,
    accumulator: 0,
    networks: new Map(),
    nameCache: new Map(),
    parentOf: new Map(),
    uidOf: new Map(),
    entities: new Set(),
    authoredQueue: [],
    eventLog: [],
    eventLogSeen: new Set(),
    runtimeDirty: new Map(),
    clock: options.clock ?? wallClock,
    trace: options.trace ?? createTraceSink()
  }
  Worlds.add(world)
  return world
}

export const destroyWorld = (world: World): void => {
  if (!Worlds.has(world)) return
  // Close every network's connections, drain their state.
  for (const network of world.networks.values()) network.close()
  world.networks.clear()
  world.nameCache.clear()
  world.parentOf.clear()
  world.uidOf.clear()
  world.authoredQueue.length = 0
  world.eventLog.length = 0
  world.eventLogSeen.clear()
  world.runtimeDirty.clear()
  // Remove every entity that belonged to this world.
  for (const entity of world.entities) {
    if (bitecs.entityExists(world.engine.bitECS, entity)) {
      bitecs.removeEntity(world.engine.bitECS, entity)
    }
  }
  world.entities.clear()
  if (bitecs.entityExists(world.engine.bitECS, world.worldRoot)) {
    bitecs.removeEntity(world.engine.bitECS, world.worldRoot)
  }
  Worlds.delete(world)
}

// ── Time loop ─────────────────────────────────────────────────────────────────

export const tickWorld = (
  world: World,
  deltaSeconds: number,
  systems: { fixed: () => void; variable: () => void }
): void => {
  world.deltaSeconds = deltaSeconds
  world.frameTime += deltaSeconds * 1000
  world.accumulator += deltaSeconds

  let safety = 0
  while (world.accumulator >= world.fixedTimeStep && safety++ < 256) {
    world.simulationTime += world.fixedTimeStep
    world.accumulator -= world.fixedTimeStep
    systems.fixed()
  }
  systems.variable()
}

// ── Stub agent (for solo + tests) ────────────────────────────────────────────

export const createAnonAgent = (seed?: string): Agent => {
  const nonce = seed ?? Math.random().toString(36).slice(2, 12)
  return { did: `did:anon:${nonce}` }
}
