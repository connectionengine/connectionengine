/**
 * Engine — the ECS runtime container.
 *
 * The Engine IS the bitECS world plus the ambient runtime state — per-component
 * storage and time. Systems run at the engine level. Multiple `World` objects
 * (virtual hierarchy + network scopes) can coexist within one engine — they
 * share storage and tick together.
 *
 * Owned here:
 *   - One bitECS world (`bitECS`). Entity IDs are unique within this engine.
 *   - Per-component storage — SoA arrays live on `ComponentDefinition` (which
 *     is a module-level singleton); instance maps + view bags live in
 *     `componentStores`, keyed by engine-global entity ID.
 *   - Time state: `clock`, `frameTime`, `simulationTime`, `fixedTimeStep`,
 *     `deltaSeconds`, `accumulator`. The engine ticks; `tickEngine` /
 *     `runSystems` drive every world rooted in it.
 *
 * Identity caches (`nameCache`, `uidOf`, `parentOf`) are NOT here — they live
 * as typed extension properties on `UIDComponent` and `BelongsTo`. The
 * extension itself is global; the inner maps are keyed by `Engine` via
 * `WeakMap` so two engines in the same process keep their state isolated
 * (entity IDs aren't unique across bitECS worlds). `destroyWorld` sweeps a
 * world's descendants from the engine's caches.
 *
 * Every `createWorld` takes an explicit `engine` — callers decide what to
 * share. Production apps construct one engine and compose worlds inside it;
 * multi-machine tests give each peer its own.
 */

import * as bitecs from 'bitecs'
import type { ComponentDefinition, PerComponentStores } from './component'
import type { Clock } from './clock'
import { wallClock } from './clock'

export interface CreateEngineOptions {
  /** Simulation tick rate in seconds. Default 1/60. */
  fixedTimeStep?: number
  /** Injectable clock — defaults to wall-clock. Tests pass a manual clock. */
  clock?: Clock
}

export interface Engine {
  /** The bitECS world — entity ID space + archetype storage. */
  readonly bitECS: bitecs.World

  /** Per-component engine-level storage (SoA arrays + instance map). Component
   *  *definitions* are global module-level singletons (`componentsById`); this
   *  is the per-engine STORAGE keyed by definition. */
  readonly componentStores: WeakMap<ComponentDefinition, PerComponentStores>

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
  clock: options.clock ?? wallClock,
  frameTime: 0,
  simulationTime: 0,
  fixedTimeStep: options.fixedTimeStep ?? 1 / 60,
  deltaSeconds: 0,
  accumulator: 0
})
