/**
 * Engine — the process-wide ECS runtime singleton.
 *
 * The Engine holds the bitECS world, plus the ambient runtime state: the
 * per-component storage and the time. Systems run at the engine level. Several
 * `World` objects, each a virtual hierarchy and network scope, can coexist
 * inside one engine. They share storage and tick together.
 *
 * The engine owns four things:
 *   - One bitECS world (`bitECS`). Entity IDs are unique inside this engine.
 *   - Per-component storage. The SoA arrays live on `ComponentDefinition`,
 *     which is a module-level singleton. The instance maps and view bags live
 *     in `componentStores`, keyed by engine-global entity ID.
 *   - Systems. `defineSystem(...)` registers phase-ordered functions.
 *     Each pushes a disposer onto `engine.disposers`.
 *   - Time state: `clock`, `frameTime`, `simulationTime`, `fixedTimeStep`,
 *     `deltaSeconds`, and `accumulator`. The engine ticks. `tickEngine` and
 *     `runSystems` drive every system registered on it.
 *
 * `initEngine(options?)` creates the singleton. A second call tears down the
 * previous engine first. `resetEngine()` tears down and clears.
 * `getEngine()` returns the live singleton; `tryGetEngine()` returns it or
 * `undefined` when no engine exists yet.
 *
 * The identity caches (`nameCache`, `uidOf`, `parentOf`) are NOT here. They
 * live as typed extension properties on `UIDComponent` and `BelongsTo`. The
 * extension itself is global. The inner maps use `Engine` as their `WeakMap`
 * key, so the caches stay scoped to the engine. `destroyWorld` sweeps the
 * descendants of a world from the caches.
 */

import * as bitecs from 'bitecs'
import type { ComponentDefinition, PerComponentStores } from './component'
import type { Clock } from './clock'
import { wallClock } from './clock'

export interface InitEngineOptions {
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
   *  `resetEngine` drains the list. Other modules may push their own. */
  readonly disposers: (() => void)[]

  // ── Time ───────────────────────────────────────────────────────────────────
  clock: Clock
  frameTime: number
  simulationTime: number
  fixedTimeStep: number
  deltaSeconds: number
  accumulator: number
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _engine: Engine | undefined

const buildEngine = (options: InitEngineOptions = {}): Engine => ({
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

/** Create the engine singleton. A second call tears down the previous one. */
export const initEngine = (options: InitEngineOptions = {}): Engine => {
  if (_engine) resetEngine()
  _engine = buildEngine(options)
  return _engine
}

/** Return the live singleton, or throw when no engine exists yet. */
export const getEngine = (): Engine => {
  if (!_engine) throw new Error('Engine not initialised — call initEngine() first')
  return _engine
}

/** Return the live singleton, or `undefined` when no engine exists yet.
 *  Use this in code that runs at module scope, before `initEngine`. */
export const tryGetEngine = (): Engine | undefined => _engine

/** Tear down the engine: drain disposers and clear the singleton. */
export const resetEngine = (): void => {
  if (!_engine) return
  for (const dispose of _engine.disposers) dispose()
  _engine.disposers.length = 0
  _engine = undefined
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
