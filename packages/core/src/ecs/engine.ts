/**
 * Engine — the ECS runtime container.
 *
 * The Engine IS the bitECS world, plus the ambient runtime state: the
 * per-component storage and the time. Systems run at the engine level. Several
 * `World` objects, each a virtual hierarchy and network scope, can coexist
 * inside one engine. They share storage and tick together.
 *
 * The engine owns four things:
 *   - One bitECS world (`bitECS`). Entity IDs are unique inside this engine.
 *   - Per-component storage. The SoA arrays live on `ComponentDefinition`,
 *     which is a module-level singleton. The instance maps and view bags live
 *     in `componentStores`, keyed by engine-global entity ID.
 *   - Systems. `defineSystem(engine, ...)` registers phase-ordered functions.
 *     Each pushes a disposer onto `engine.disposers`.
 *   - Time state: `clock`, `frameTime`, `simulationTime`, `fixedTimeStep`,
 *     `deltaSeconds`, and `accumulator`. The engine ticks. `tickEngine` and
 *     `runSystems` drive every system registered on it.
 *
 * `destroyEngine(engine)` drains the disposer list, which disposes every
 * system reactor. Call it after destroying the worlds that share this engine.
 *
 * The identity caches (`nameCache`, `uidOf`, `parentOf`) are NOT here. They
 * live as typed extension properties on `UIDComponent` and `BelongsTo`. The
 * extension itself is global. The inner maps use `Engine` as their `WeakMap`
 * key, so two engines in the same process keep their state isolated, because
 * entity IDs are not unique across bitECS worlds. `destroyWorld` sweeps the
 * descendants of a world from the caches of the engine.
 *
 * Every `createWorld` takes an explicit `engine`, so the caller decides what to
 * share. A production app constructs one engine and composes its worlds inside
 * it. A multi-machine test gives each peer its own engine.
 */

import * as bitecs from 'bitecs'
import type { ComponentDefinition, PerComponentStores } from './component'
import type { Clock } from './clock'
import { wallClock } from './clock'

export interface CreateEngineOptions {
  /** Simulation tick rate in seconds. Default 1/60. */
  fixedTimeStep?: number
  /** Injectable clock. It defaults to the wall clock. A test passes a manual clock. */
  clock?: Clock
}

export interface Engine {
  /** The bitECS world. It holds the entity ID space and the archetype storage. */
  readonly bitECS: bitecs.World

  /** Per-component engine-level storage: the instance map and the view bags.
   *  The SoA arrays live on the definition itself. Component *definitions* are
   *  global module-level singletons, held in `componentsById`. This map is the
   *  per-engine STORAGE, keyed by definition. */
  readonly componentStores: WeakMap<ComponentDefinition, PerComponentStores>

  /** Teardown callbacks. `defineSystem` pushes its disposer here.
   *  `destroyEngine` drains the list. Other modules may push their own. */
  readonly disposers: (() => void)[]

  // ── Time ───────────────────────────────────────────────────────────────────
  clock: Clock
  frameTime: number
  simulationTime: number
  fixedTimeStep: number
  deltaSeconds: number
  accumulator: number
}

/** Create a fresh isolated engine. */
export const createEngine = (options: CreateEngineOptions = {}): Engine => ({
  bitECS: bitecs.createWorld(),
  componentStores: new WeakMap(),
  disposers: [],
  clock: options.clock ?? wallClock,
  frameTime: 0,
  simulationTime: 0,
  fixedTimeStep: options.fixedTimeStep ?? 1 / 60,
  deltaSeconds: 0,
  accumulator: 0
})

/** Tear down an engine and release its resources. It disposes every system
 *  reactor and drains the disposer list. */
export const destroyEngine = (engine: Engine): void => {
  for (const dispose of engine.disposers) dispose()
  engine.disposers.length = 0
}

// ── Time loop ────────────────────────────────────────────────────────────────

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
