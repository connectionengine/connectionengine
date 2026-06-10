/**
 * World — a virtual hierarchy + identity scope inside an Engine.
 *
 * The ECS runs on the Engine: bitECS storage, per-component storage, time,
 * systems. Everything that's "ECS" is engine-wide. A `World` is a virtual
 * scope on top — a `worldRoot` entity that anchors a `BelongsTo` subtree,
 * plus the per-world mutation pipeline state (`authoredQueue`, `eventLog`,
 * `runtimeDirty`) and the local identity (`localAgent`, `localUser`,
 * `localPeer`).
 *
 * Networks are not on the world. They live in a per-world registry in
 * `network/network.ts` (`getNetworks(world)` / `addNetwork(world, …)` /
 * `ensureDefaultNetwork(world)`), keeping the `ecs/` layer free of any
 * network-layer types.
 *
 * Many Worlds can coexist in one Engine, but ECS queries and systems
 * operate engine-wide. Callers that want world-scoped iteration walk the
 * `BelongsTo` tree from `worldRoot`. Tests that need fully isolated peers
 * give each peer its own Engine.
 */

import * as bitecs from 'bitecs'
import type { Engine } from './engine'
import { collectDescendants, removeEntity } from './entity'

export type Entity = number

/** Mutation source — drives re-broadcast suppression. `local` writes enqueue
 *  for outbound; `network` writes came in over the wire and don't. */
export type Origin = 'local' | 'network'

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

// ── Authored events (network-layer types, named here so World can carry them) ─

export interface AuthoredEvent {
  entityPath: string[]
  predicate: string
  op: 'set' | 'remove' | 'spawn' | 'destroy'
  value: unknown
  /** Author DID (string). Attached by `flushAuthored` for local events; carried verbatim for received events. */
  author: string
  /** ms since epoch. Attached by `flushAuthored` from the engine clock. */
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

// ── World ────────────────────────────────────────────────────────────────────

export interface World {
  /** The engine this world belongs to. */
  readonly engine: Engine

  /**
   * Sentinel root entity for this world. `spawnPrefab` parents wire-addressable
   * entities under `worldRoot` via `BelongsTo`, giving the world a single
   * subtree to call its own inside the engine's shared bitECS storage.
   */
  readonly worldRoot: Entity

  /** Local agent identity. One per world. */
  localAgent: Agent

  // ── Mutation pipeline state (network-layer state, per-world) ───────────────
  authoredQueue: QueuedAuthored[]
  /** Append-only canonical event log — plain AuthoredEvent (no signatures). */
  eventLog: AuthoredEvent[]
  /** Composite-signature index of events present in `eventLog`. Dedup on every push. */
  eventLogSeen: Set<string>
  /** Runtime dirty set — written by setComponent on continuous-channel components. */
  runtimeDirty: Map<string, Set<Entity>>

  /** Local peer entity (set on createPeer for this runtime). */
  localPeer?: Entity

  /** Local user entity (set on createUser with `asLocal: true`). */
  localUser?: Entity
}

export const Worlds = new Set<World>()

// ── Destroy hooks ─────────────────────────────────────────────────────────────
//
// Higher layers (network/, plugins) register cleanup callbacks that run when a
// world is destroyed. Keeps `destroyWorld` ignorant of any layer above it.

type DestroyHook = (world: World) => void
const destroyHooks = new Set<DestroyHook>()

/** Register a callback that runs from `destroyWorld` before the world is
 *  removed from `Worlds`. Returns an unregister function. */
export const onWorldDestroy = (hook: DestroyHook): (() => void) => {
  destroyHooks.add(hook)
  return () => destroyHooks.delete(hook)
}

export interface CreateWorldOptions {
  /** Engine to allocate this world inside. Always explicit — there is no
   *  ambient engine. Production apps construct one engine and compose worlds
   *  inside it; multi-machine tests create one per peer. */
  engine: Engine
  /** Local agent identity. Required — runtime modes provide a real agent;
   *  solo callers can pass a stub `{ did: 'did:anon:xxx' }`. */
  agent: Agent
}

export const createWorld = (options: CreateWorldOptions): World => {
  const { engine } = options
  const worldRoot = bitecs.addEntity(engine.bitECS)
  const world: World = {
    engine,
    worldRoot,
    localAgent: options.agent,
    authoredQueue: [],
    eventLog: [],
    eventLogSeen: new Set(),
    runtimeDirty: new Map()
  }
  Worlds.add(world)
  return world
}

export const destroyWorld = (world: World): void => {
  if (!Worlds.has(world)) return
  // Higher-layer cleanup (networks close + clear, plugin state) runs first.
  for (const hook of destroyHooks) hook(world)
  world.authoredQueue.length = 0
  world.eventLog.length = 0
  world.eventLogSeen.clear()
  world.runtimeDirty.clear()
  // Sweep every entity reachable from worldRoot. Identity caches are per-
  // engine (via WeakMap on UIDComponent / BelongsTo); cleaning up descendants
  // keeps subsequent worlds in the same engine from seeing stale entries.
  for (const e of collectDescendants(world.engine, world.worldRoot)) removeEntity(world, e)
  if (bitecs.entityExists(world.engine.bitECS, world.worldRoot)) {
    bitecs.removeEntity(world.engine.bitECS, world.worldRoot)
  }
  Worlds.delete(world)
}

// ── Time loop ─────────────────────────────────────────────────────────────────

/**
 * Advance the engine's time and run a frame of systems. The engine owns time —
 * ticking advances `engine.frameTime`, `engine.simulationTime`, etc. Systems
 * registered on the engine run for every world rooted in it.
 */
export const tickEngine = (
  engine: Engine,
  deltaSeconds: number,
  systems: { fixed: () => void; variable: () => void }
): void => {
  engine.deltaSeconds = deltaSeconds
  engine.frameTime += deltaSeconds * 1000
  engine.accumulator += deltaSeconds

  let safety = 0
  while (engine.accumulator >= engine.fixedTimeStep && safety++ < 256) {
    engine.simulationTime += engine.fixedTimeStep
    engine.accumulator -= engine.fixedTimeStep
    systems.fixed()
  }
  systems.variable()
}

// ── Stub agent (for solo + tests) ────────────────────────────────────────────

export const createAnonAgent = (seed?: string): Agent => {
  const nonce = seed ?? Math.random().toString(36).slice(2, 12)
  return { did: `did:anon:${nonce}` }
}
