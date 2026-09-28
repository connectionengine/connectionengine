/**
 * World — a virtual hierarchy and identity scope inside the Engine.
 *
 * The ECS runs on the Engine, which holds bitECS storage, per-component
 * storage, time, and systems. Everything that counts as "ECS" lives
 * engine-wide. A `World` adds a virtual scope on top. It holds a `worldRoot`
 * entity that anchors a `BelongsTo` subtree, the per-world mutation pipeline
 * state (`destroyQueue`, `eventLog`, `runtimeDirty`, `authoredCursor`), and
 * the local identity (`localAgent`, `localUser`, `localPeer`).
 *
 * The event log holds every AuthoredEvent produced by local mutation verbs
 * (`setComponent`, `addRelation`, etc.) at mutation time. `flushAuthored`
 * reads from `authoredCursor` forward, filters by local author, and
 * broadcasts. Destroy events remain queue-based because the ownership check
 * needs `OwnedBy` from `network/authority.ts`, which `ecs/` cannot import.
 *
 * The world also carries its `networks` map. `ecs/` names the `Network` type
 * through an inline import and never imports the module, so the layering holds
 * while the state stays where it belongs. Build and read them through
 * `addNetwork(world, …)`, `getNetworks(world)`, and `ensureDefaultNetwork(world)`
 * in `network/network.ts`.
 *
 * Many Worlds can coexist in one Engine. ECS queries and systems operate
 * engine-wide. A caller that wants world-scoped iteration walks the `BelongsTo`
 * tree from `worldRoot`.
 */

import * as bitecs from 'bitecs'
import type { Engine } from './engine'
import { getEngine } from './engine'
import { collectDescendants, destroyEntity } from './entity'

export type Entity = number

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

// ── Queue types ─────────────────────────────────────────────────────────────-

/**
 * An entity destroy queued for the authored flush. The entity path and indexed
 * relations must be captured before destruction clears the identity caches,
 * because neither survives to flush time. Destroy events stay queue-based
 * because the ownership check needs `OwnedBy` from `network/authority.ts`,
 * which `ecs/` cannot import.
 */
export interface QueuedDestroy {
  entity: Entity
  entityPath: string[]
  indexed?: ReadonlyMap<import('./relation').RelationDefinition<unknown>, Entity>
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

  /** Entity destroy queue. `removeEntity` pushes entries (with captured path).
   *  `flushAuthored` drains it with an ownership filter. */
  destroyQueue: QueuedDestroy[]

  /** Append-only canonical event log. Local mutation verbs (`setComponent`,
   *  `addRelation`, etc.) append events at mutation time. The receive path
   *  also appends for dedup. */
  eventLog: AuthoredEvent[]
  /** Composite-signature index of the events in `eventLog`. Every push
   *  deduplicates against it. */
  eventLogSeen: Set<string>
  /** Ordinal of the next locally authored event. See `AuthoredEvent.seq`. */
  authoredSeq: number
  /** Position in `eventLog` from which `flushAuthored` reads on the next
   *  flush. Advances after each flush. */
  authoredCursor: number
  /** Cached entity → full UID path. `setUID` and `assignIdentity` maintain it.
   *  `setComponent` and `addRelation` read it to stamp authored events without
   *  importing entity.ts. */
  entityPaths: Map<Entity, string[]>
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

  /** Counter for the next networkId allocation. The `NetworkId` component on
   *  each entity stores the assigned value. Starts at 1 — 0 means unmapped. */
  nextNetworkId: number
}

export interface CreateWorldOptions {
  /** Local agent identity. Required. A runtime mode supplies a real agent. A
   *  solo caller can pass a stub, such as `{ did: 'did:anon:xxx' }`. */
  agent: Agent
}

export const createWorld = (options: CreateWorldOptions, engine: Engine = getEngine()): World => {
  const worldRoot = bitecs.addEntity(engine.bitECS)
  const world: World = {
    engine,
    worldRoot,
    localAgent: options.agent,
    destroyQueue: [],
    eventLog: [],
    eventLogSeen: new Set(),
    authoredSeq: 0,
    authoredCursor: 0,
    entityPaths: new Map(),
    runtimeDirty: new Map(),
    networks: new Map(),
    nextNetworkId: 1
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
  for (const e of collectDescendants(world.engine, world.worldRoot)) destroyEntity(world, e)
  if (bitecs.entityExists(world.engine.bitECS, world.worldRoot)) {
    bitecs.removeEntity(world.engine.bitECS, world.worldRoot)
  }
  world.destroyQueue.length = 0
  world.eventLog.length = 0
  world.eventLogSeen.clear()
  world.authoredCursor = 0
  world.runtimeDirty.clear()
}

// Event log helpers live in `event-log.ts` to avoid a circular import through
// entity.ts. Both `ecs/` mutation verbs and `network/` flush+apply import from
// there directly.

// ── Stub agent. Use it for solo mode and for tests. ──────────────────────────

export const createAnonAgent = (seed?: string): Agent => {
  const nonce = seed ?? Math.random().toString(36).slice(2, 12)
  return { did: `did:anon:${nonce}` }
}
