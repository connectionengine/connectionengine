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
 * The world also carries its `networks` map. `ecs/` names the `Network` type
 * through an inline import and never imports the module, so the layering holds
 * while the state stays where it belongs. Build and read them through
 * `addNetwork(world, …)`, `getNetworks(world)`, and `ensureDefaultNetwork(world)`
 * in `network/network.ts`.
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
  op: 'set' | 'remove' | 'destroy'
  value: unknown
  /** Author DID, as a string. `flushAuthored` attaches it to a local event. A
   *  received event carries it unchanged. */
  author: string
  /** Milliseconds since epoch. `flushAuthored` attaches it from the engine clock. */
  timestamp: number
  /**
   * Per-author ordinal, assigned by `flushAuthored`. It disambiguates two
   * events that an author emits in the same clock tick.
   *
   * The clock has millisecond resolution, so a whole frame of writes usually
   * carries one timestamp. Without this field, writing a value, changing it,
   * and restoring it inside one frame produces two identical signatures, and
   * `appendEventLog` drops the third write as a duplicate. Local and remote
   * state then diverge permanently.
   */
  seq: number
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
  op: 'set' | 'remove' | 'destroy'
  value: unknown
  origin: 'local' | 'network'
  /**
   * Entity path captured at queue time. `flushAuthored` normally resolves the
   * path itself, but `removeEntity` clears the identity caches before the
   * flush runs, so a destroy has to carry its own path.
   */
  entityPath?: string[]
  /**
   * Index entries captured at queue time, for the same reason as `entityPath`:
   * the entity no longer exists when the flush runs. Keyed by relation
   * definition, so a reader stays typed — `queued.indexed?.get(OwnedBy)`.
   *
   * `flushAuthored` reads the `OwnedBy` entry to decide whether this peer may
   * announce the removal.
   */
  indexed?: ReadonlyMap<import('./relation').RelationDefinition<unknown>, Entity>
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
  /** Ordinal of the next locally authored event. See `AuthoredEvent.seq`. */
  authoredSeq: number
  /** Runtime dirty set. `setComponent` writes to it for continuous-channel
   *  components. */
  runtimeDirty: Map<string, Set<Entity>>
  /**
   * Sync topologies on this world, keyed by network id.
   *
   * `Network` is a network-layer type, so `ecs/` names it only through the
   * inline import below and never imports the module. Holding it here rather
   * than in a side table keeps per-world state in one place: `destroyWorld`
   * clears what the world holds, instead of every layer having to remember its
   * own map.
   */
  networks: Map<string, import('../network/network').Network>

  /** Local peer entity. `createPeer` sets it for this runtime. */
  localPeer?: Entity

  /** Local user entity. `createUser` sets it when passed `asLocal: true`. */
  localUser?: Entity
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
    authoredSeq: 0,
    runtimeDirty: new Map(),
    networks: new Map()
  }
  return world
}

export const destroyWorld = (world: World): void => {
  // The world holds its networks, so it closes them. `World` already names the
  // `Network` type, and `close()` is part of that type, so this needs no hook
  // and no import.
  for (const network of world.networks.values()) network.close()
  world.networks.clear()
  // Sweep every entity that is reachable from worldRoot. The identity caches
  // are per-engine, through the WeakMaps on UIDComponent and BelongsTo. Cleanup
  // of the descendants stops a later world in the same engine from reading a
  // stale entry.
  for (const e of collectDescendants(world.engine, world.worldRoot)) removeEntity(world, e)
  if (bitecs.entityExists(world.engine.bitECS, world.worldRoot)) {
    bitecs.removeEntity(world.engine.bitECS, world.worldRoot)
  }
  // The pipeline state clears last. Each `removeEntity` above queues a destroy,
  // so clearing first would leave the queue dirty on a world that no longer
  // exists.
  world.authoredQueue.length = 0
  world.eventLog.length = 0
  world.eventLogSeen.clear()
  world.runtimeDirty.clear()
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
