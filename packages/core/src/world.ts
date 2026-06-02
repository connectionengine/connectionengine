/**
 * World — top-level ECS + Network container.
 *
 * Extends bitECS's World with engine bindings: time state, realtime bindings
 * (connections, schemas), entity identity caches (BelongsTo → uid → child),
 * the per-world authored mutation queue + event log, a runtime dirty-flag set,
 * and the structured trace sink. Multiple worlds coexist; nothing global.
 */

import * as bitecs from 'bitecs'
import type { Clock } from './clock'
import { wallClock } from './clock'
import type { TraceSink } from './trace'
import { createTraceSink } from './trace'
import type { SignedTriple } from './did'

export type Entity = number

/** Forward-declared — full shape in transport.ts. */
export interface Connection {
  peer: Entity
  backend: 'webrtc' | 'websocket' | 'memory'
  send(payload: TransportPayload): void
  close(): void
}

/** Forward-declared — full shape in mutation.ts. */
export interface TransportPayload {
  kind: 'authored' | 'runtime'
  data: unknown
  fromPeer: string
}

/** Forward-declared — full shape in component.ts. */
export interface ComponentSchema {
  readonly id: string
  readonly jsonSchema: object
  readonly shaclShape: object
  readonly mutationCategory: 'authored' | 'runtime' | 'local'
}

/** A queued authored mutation awaiting end-of-tick batch + send. */
export interface QueuedAuthored {
  triple: SignedTriple
  /** Origin: 'local' goes outbound; 'network' does not (received). */
  origin: 'local' | 'network'
}

/** Dirty marker for runtime components. */
export interface DirtyKey {
  entity: Entity
  componentId: string
}

export interface RealtimeBindings {
  /** Active peer connections for this world's live session. */
  connections: Set<Connection>
  /** Component id → ComponentSchema (shareable metadata). */
  schemas: Map<string, ComponentSchema>
  /** Local peer DID (set when this world joins a session as a peer). */
  localPeerDID?: string
  /** Local peer entity (set on createPeer for this runtime). */
  localPeer?: Entity
}

export interface World extends bitecs.World {
  // Time
  frameTime: number
  simulationTime: number
  fixedTimeStep: number
  deltaSeconds: number
  accumulator: number

  // Realtime
  network: RealtimeBindings

  // Identity caches — populated by observers on BelongsTo + UIDComponent
  /** parent entity → (uid → child entity) */
  nameCache: Map<Entity, Map<string, Entity>>
  /** child entity → parent entity (reverse for unlink + path walking) */
  parentOf: Map<Entity, Entity>
  /** entity → uid (reverse for path walking + cache invalidation) */
  uidOf: Map<Entity, string>

  // Mutation pipeline state
  authoredQueue: QueuedAuthored[]
  /** Append-only canonical event log (authored mutations only). */
  eventLog: SignedTriple[]
  /** Runtime dirty set — written by setComponent on runtime-category components. */
  runtimeDirty: Map<string, Set<Entity>>

  // Infrastructure
  clock: Clock
  trace: TraceSink
}

export const Worlds = new Set<World>()

export interface CreateWorldOptions {
  /** Simulation tick rate in seconds. Default 1/60. */
  fixedTimeStep?: number
  /** Injectable clock — defaults to wall-clock. Tests pass a manual clock. */
  clock?: Clock
  /** Trace sink — defaults to an in-memory recording sink. */
  trace?: TraceSink
}

export const createWorld = (options: CreateWorldOptions = {}): World => {
  const world = bitecs.createWorld() as World
  world.frameTime = 0
  world.simulationTime = 0
  world.fixedTimeStep = options.fixedTimeStep ?? 1 / 60
  world.deltaSeconds = 0
  world.accumulator = 0
  world.network = {
    connections: new Set(),
    schemas: new Map()
  }
  world.nameCache = new Map()
  world.parentOf = new Map()
  world.uidOf = new Map()
  world.authoredQueue = []
  world.eventLog = []
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
