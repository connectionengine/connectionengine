/**
 * World — a virtual hierarchy and identity scope inside an Engine.
 *
 * The ECS runs on the Engine, which holds bitECS storage, per-component
 * storage, time, and systems. Everything that counts as "ECS" is engine-wide.
 * A `World` is a virtual scope on top. It holds a `worldRoot` entity that
 * anchors a `BelongsTo` subtree, the per-world mutation pipeline state
 * (`authoredQueue`, `eventLog`, `runtimeDirty`), and the local identity
 * (`localAgent`, `localUser`, `localPeer`).
 *
 * Networks do not live on the world. They live in a per-world registry in
 * `network/network.ts`. See `getNetworks(world)`, `addNetwork(world, …)`, and
 * `ensureDefaultNetwork(world)`. This keeps the `ecs/` layer free of every
 * network-layer type.
 *
 * Many Worlds can coexist in one Engine, but ECS queries and systems operate
 * engine-wide. A caller that wants world-scoped iteration walks the `BelongsTo`
 * tree from `worldRoot`. A test that needs fully isolated peers gives each peer
 * its own Engine.
 */

import * as bitecs from 'bitecs'
import type { Engine } from './engine'
import { collectDescendants, removeEntity } from './entity'

export type Entity = number

/** Mutation source. It drives re-broadcast suppression. A `local` write queues
 *  for outbound. A `network` write arrived over the wire, and does not queue. */
export type Origin = 'local' | 'network'

// ── Agent (opaque local identity) ────────────────────────────────────────────

/**
 * Local agent identity. The engine treats `did` as an opaque string. `sign` is
 * optional. Only a runtime mode that must sign outbound events uses it.
 */
export interface Agent {
  readonly did: string
  /** Optional sign hook. A runtime mode that wraps outbound events supplies it. */
  sign?: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>
}

// ── Authored events. These are network-layer types. They are declared here so
//    that World can carry them. ───────────────────────────────────────────────

export interface AuthoredEvent {
  entityPath: string[]
  predicate: string
  op: 'set' | 'remove' | 'spawn' | 'destroy'
  value: unknown
  /** Author DID, as a string. `flushAuthored` attaches it to a local event. A
   *  received event carries it unchanged. */
  author: string
  /** Milliseconds since epoch. `flushAuthored` attaches it from the engine clock. */
  timestamp: number
}

/** Wire-shape envelope that carries the authored events of one peer. */
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
  /** The engine that owns this world. */
  readonly engine: Engine

  /**
   * Sentinel root entity for this world. `spawnPrefab` parents every
   * wire-addressable entity under `worldRoot` through `BelongsTo`. The world
   * therefore owns one subtree inside the shared bitECS storage of the engine.
   */
  readonly worldRoot: Entity

  /** Local agent identity. One per world. */
  localAgent: Agent

  // ── Mutation pipeline state. Network-layer state, held per world. ──────────
  authoredQueue: QueuedAuthored[]
  /** Append-only canonical event log. It holds plain AuthoredEvent records,
   *  with no signatures. */
  eventLog: AuthoredEvent[]
  /** Composite-signature index of the events in `eventLog`. Every push
   *  deduplicates against it. */
  eventLogSeen: Set<string>
  /** Runtime dirty set. `setComponent` writes to it for continuous-channel
   *  components. */
  runtimeDirty: Map<string, Set<Entity>>

  /** Local peer entity. `createPeer` sets it for this runtime. */
  localPeer?: Entity

  /** Local user entity. `createUser` sets it when passed `asLocal: true`. */
  localUser?: Entity
}

export const Worlds = new Set<World>()

// ── Destroy hooks ─────────────────────────────────────────────────────────────
//
// A higher layer, such as `network/` or a plugin, registers a cleanup callback
// that runs when the engine destroys a world. This keeps `destroyWorld`
// ignorant of every layer above it.

type DestroyHook = (world: World) => void
const destroyHooks = new Set<DestroyHook>()

/** Register a callback. `destroyWorld` runs it before it removes the world from
 *  `Worlds`. This function returns an unregister function. */
export const onWorldDestroy = (hook: DestroyHook): (() => void) => {
  destroyHooks.add(hook)
  return () => destroyHooks.delete(hook)
}

export interface CreateWorldOptions {
  /** Engine that allocates this world. Always pass it explicitly. A production
   *  app constructs one engine and composes its worlds inside it. A
   *  multi-machine test creates one engine per peer. */
  engine: Engine
  /** Local agent identity. Required. A runtime mode supplies a real agent. A
   *  solo caller can pass a stub, such as `{ did: 'did:anon:xxx' }`. */
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
  // Higher-layer cleanup runs first. It closes and clears the networks, and it
  // clears the plugin state.
  for (const hook of destroyHooks) hook(world)
  world.authoredQueue.length = 0
  world.eventLog.length = 0
  world.eventLogSeen.clear()
  world.runtimeDirty.clear()
  // Sweep every entity that is reachable from worldRoot. The identity caches
  // are per-engine, through the WeakMaps on UIDComponent and BelongsTo. Cleanup
  // of the descendants stops a later world in the same engine from reading a
  // stale entry.
  for (const e of collectDescendants(world.engine, world.worldRoot)) removeEntity(world, e)
  if (bitecs.entityExists(world.engine.bitECS, world.worldRoot)) {
    bitecs.removeEntity(world.engine.bitECS, world.worldRoot)
  }
  Worlds.delete(world)
}

// ── Time loop ─────────────────────────────────────────────────────────────────

/**
 * Advance the time of the engine, and run one frame of systems. The engine owns
 * time. Each tick advances `engine.frameTime`, `engine.simulationTime`, and the
 * other time fields. Every system registered on the engine runs for every world
 * rooted in it.
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

// ── Stub agent. Use it for solo mode and for tests. ──────────────────────────

export const createAnonAgent = (seed?: string): Agent => {
  const nonce = seed ?? Math.random().toString(36).slice(2, 12)
  return { did: `did:anon:${nonce}` }
}
