/**
 * System — phase-ordered functions with an optional reactor.
 *
 * `defineSystem(engine, definition)` registers a system on the engine.
 *   - phase: Input, Simulation, Animation, or Render. The phase selects the
 *     fixed or the variable timestep. Simulation uses the fixed timestep.
 *   - execute(engine, deltaTime): the continuous logic. It runs every tick in
 *     its phase.
 *   - reactor(): a DOMless Solid component, logic only. `createRoot` mounts it
 *     once at registration. `removeSystem` and `destroyEngine` dispose it.
 *   - before / after: ordering constraints. Each one names another system in
 *     the same phase. Every register and unregister sorts the phase
 *     topologically.
 *
 * `runSystems(engine, deltaSeconds)` drives one frame. `tickEngine` gives the
 * fixed substeps to the Simulation systems, and the variable steps to the rest.
 *
 * Systems belong to the engine, not to a world. The ECS operates engine-wide:
 * queries, entities, SoA storage, and time all live on the engine, so systems
 * match. `defineSystem` pushes a disposer that `destroyEngine` drains — setup
 * registers teardown, the same principle that governs `attachConnection`.
 *
 * This module knows nothing about authoring or replication. A driver that
 * flushes networking at frame end calls `flushAuthored` and `flushRuntime`
 * from `network/mutation` after `runSystems` returns.
 */

import { createRoot } from 'solid-js'
import type { Engine } from './engine'
import { tickEngine } from './world'

export type Phase = 'Input' | 'Simulation' | 'Animation' | 'Render'
export const PHASES: readonly Phase[] = ['Input', 'Simulation', 'Animation', 'Render'] as const

export type ExecutionContext = 'main' | 'worker' | 'server'
export type ReactorFunction = () => void

export interface SystemDefinition {
  name: string
  phase: Phase
  context?: ExecutionContext
  before?: string[]
  after?: string[]
  execute?: (engine: Engine, deltaTime: number) => void
  reactor?: ReactorFunction
}

export interface SystemHandle {
  readonly name: string
  readonly phase: Phase
  readonly definition: SystemDefinition
  /** Solid root disposer for the reactor that is mounted now, if one is. */
  dispose?: () => void
}

interface SchedulerState {
  /** The systems of each phase, held in topological order. */
  byPhase: Map<Phase, SystemHandle[]>
  /** Every handle, tracked so that destroyEngine can clean them up. */
  all: Set<SystemHandle>
}

const schedulers = new WeakMap<Engine, SchedulerState>()

const getOrCreate = (engine: Engine): SchedulerState => {
  let state = schedulers.get(engine)
  if (!state) {
    state = { byPhase: new Map(PHASES.map((p) => [p, []])), all: new Set() }
    schedulers.set(engine, state)
  }
  return state
}

const sortPhase = (handles: SystemHandle[]): SystemHandle[] => {
  // Kahn topological sort, by the before and after constraints. It keeps the
  // insertion order for the systems that hold no constraint.
  const byName = new Map<string, SystemHandle>()
  for (const h of handles) byName.set(h.name, h)
  const edges = new Map<string, Set<string>>() // dep → dependents
  const indeg = new Map<string, number>()
  for (const h of handles) {
    indeg.set(h.name, 0)
    edges.set(h.name, new Set())
  }
  const addEdge = (from: string, to: string): void => {
    if (!byName.has(from) || !byName.has(to)) return
    const dependents = edges.get(from)!
    if (dependents.has(to)) return
    dependents.add(to)
    indeg.set(to, (indeg.get(to) ?? 0) + 1)
  }
  for (const h of handles) {
    for (const before of h.definition.before ?? []) addEdge(h.name, before)
    for (const after of h.definition.after ?? []) addEdge(after, h.name)
  }
  const queue: string[] = []
  for (const h of handles) if ((indeg.get(h.name) ?? 0) === 0) queue.push(h.name)
  const sorted: SystemHandle[] = []
  while (queue.length > 0) {
    const name = queue.shift()!
    const h = byName.get(name)
    if (!h) continue
    sorted.push(h)
    for (const dep of edges.get(name) ?? []) {
      indeg.set(dep, (indeg.get(dep) ?? 0) - 1)
      if (indeg.get(dep) === 0) queue.push(dep)
    }
  }
  if (sorted.length !== handles.length) {
    // The graph holds a cycle. Fall back to the insertion order.
    return handles
  }
  return sorted
}

export const defineSystem = (engine: Engine, definition: SystemDefinition): SystemHandle => {
  const state = getOrCreate(engine)
  let dispose: (() => void) | undefined
  if (definition.reactor) {
    const reactor = definition.reactor
    dispose = createRoot((d) => {
      reactor()
      return d
    })
  }
  const handle: SystemHandle = { name: definition.name, phase: definition.phase, definition, dispose }
  state.all.add(handle)
  const phaseList = state.byPhase.get(definition.phase) ?? []
  phaseList.push(handle)
  state.byPhase.set(definition.phase, sortPhase(phaseList))
  // Setup registers teardown. destroyEngine drains this list.
  engine.disposers.push(() => removeSystem(engine, handle))
  return handle
}

export const removeSystem = (engine: Engine, handle: SystemHandle): void => {
  const state = schedulers.get(engine)
  if (!state) return
  state.all.delete(handle)
  const phaseList = state.byPhase.get(handle.phase)
  if (phaseList)
    state.byPhase.set(
      handle.phase,
      phaseList.filter((h) => h !== handle)
    )
  handle.dispose?.()
  handle.dispose = undefined
}

/**
 * Inject a system that was defined earlier into an engine.
 *
 * This function attaches a `SystemHandle` to the phase scheduler of the engine
 * again. `defineSystem` produced that handle, or an earlier `removeSystem` call
 * released it. The function mounts the reactor of the handle again, under a
 * fresh `createRoot`. Plugin systems that detach and attach with the lifecycle
 * of their host use it.
 *
 * The function throws if a *different* handle with the same `name` already
 * exists on this engine. It does nothing when the handle already exists.
 */
export const injectSystem = (engine: Engine, handle: SystemHandle): void => {
  const state = getOrCreate(engine)
  if (state.all.has(handle)) return
  for (const existing of state.all) {
    if (existing.name === handle.name) {
      throw new Error(`injectSystem: a different system named "${handle.name}" already exists on this engine`)
    }
  }
  if (handle.definition.reactor) {
    const reactor = handle.definition.reactor
    handle.dispose = createRoot((d) => {
      reactor()
      return d
    })
  }
  state.all.add(handle)
  const phaseList = state.byPhase.get(handle.phase) ?? []
  phaseList.push(handle)
  state.byPhase.set(handle.phase, sortPhase(phaseList))
}

export const reorderSystem = (
  engine: Engine,
  handle: SystemHandle,
  ordering: { before?: string[]; after?: string[] }
): void => {
  ;(handle.definition as { before?: string[]; after?: string[] }).before = ordering.before ?? handle.definition.before
  ;(handle.definition as { before?: string[]; after?: string[] }).after = ordering.after ?? handle.definition.after
  const state = schedulers.get(engine)
  if (!state) return
  const phaseList = state.byPhase.get(handle.phase) ?? []
  state.byPhase.set(handle.phase, sortPhase(phaseList))
}

export const listSystems = (engine: Engine, phase?: Phase): SystemHandle[] => {
  const state = schedulers.get(engine)
  if (!state) return []
  if (phase) return state.byPhase.get(phase)?.slice() ?? []
  return Array.from(state.all)
}

// ── Frame runner ──────────────────────────────────────────────────────────────

/**
 * Drive one frame of the engine. It executes the systems in phase order.
 *
 * Phase order: Input → Simulation (fixed substeps) → Animation → Render.
 *
 * This function does NOT flush networking. A driver that needs end-of-frame
 * replication calls `flushAuthored` and `flushRuntime` after this function
 * returns.
 */
export const runSystems = (engine: Engine, deltaSeconds: number): void => {
  const state = getOrCreate(engine)
  const runPhase = (phase: Phase, dt: number): void => {
    for (const handle of state.byPhase.get(phase) ?? []) {
      handle.definition.execute?.(engine, dt)
    }
  }
  // Input runs once per frame, at the variable timestep.
  runPhase('Input', deltaSeconds)
  // tickEngine drives Simulation in fixed substeps, then the variable phases.
  tickEngine(engine, deltaSeconds, {
    fixed: () => runPhase('Simulation', engine.fixedTimeStep),
    variable: () => {
      runPhase('Animation', deltaSeconds)
      runPhase('Render', deltaSeconds)
    }
  })
}

/** Dispose every system on an engine and remove the scheduler state. */
export const disposeAllSystems = (engine: Engine): void => {
  const state = schedulers.get(engine)
  if (!state) return
  for (const h of state.all) h.dispose?.()
  schedulers.delete(engine)
}
