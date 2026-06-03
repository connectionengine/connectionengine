/**
 * System — phase-ordered functions with optional reactor.
 *
 * defineSystem registers a system into a world's phase scheduler.
 *   - phase: Input | Simulation | Animation | Render — determines fixed vs
 *     variable timestep (Simulation = fixed).
 *   - execute(world, deltaTime): continuous logic run every tick in phase.
 *   - reactor(): a DOMless Solid component (logic only). Mounted once via
 *     createRoot at registration; disposed on removeSystem or destroyWorld.
 *   - before / after: ordering constraints — names of other systems in the
 *     same phase. Topologically sorted on each (un)register.
 *
 * runSystems(world, deltaSeconds) drives one frame: tickWorld delegates the
 * fixed substeps to Simulation systems and variable steps to the rest.
 * Authored + runtime flushes run at end-of-frame after Render.
 *
 * Maps to canonical doc §3.10.
 */

import { createRoot } from 'solid-js'
import type { World } from '../ecs/world'
import { tickWorld } from '../ecs/world'
import { flushAuthored, flushRuntime } from './mutation'

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
  execute?: (world: World, deltaTime: number) => void
  reactor?: ReactorFunction
}

export interface SystemHandle {
  readonly name: string
  readonly phase: Phase
  readonly definition: SystemDefinition
  /** Solid root disposer (if reactor was mounted). */
  readonly dispose?: () => void
}

interface SchedulerState {
  /** Systems per phase, kept in topological order. */
  byPhase: Map<Phase, SystemHandle[]>
  /** Track all handles for cleanup on destroyWorld. */
  all: Set<SystemHandle>
}

const schedulers = new WeakMap<World, SchedulerState>()

const getOrCreate = (world: World): SchedulerState => {
  let state = schedulers.get(world)
  if (!state) {
    state = { byPhase: new Map(PHASES.map((p) => [p, []])), all: new Set() }
    schedulers.set(world, state)
  }
  return state
}

const sortPhase = (handles: SystemHandle[]): SystemHandle[] => {
  // Kahn's topological sort by before/after constraints, preserving insertion
  // order for unconstrained systems.
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
    // Cycle — fall back to insertion order and warn via trace
    return handles
  }
  return sorted
}

export const defineSystem = (world: World, definition: SystemDefinition): SystemHandle => {
  const state = getOrCreate(world)
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
  return handle
}

export const removeSystem = (world: World, handle: SystemHandle): void => {
  const state = schedulers.get(world)
  if (!state) return
  state.all.delete(handle)
  const phaseList = state.byPhase.get(handle.phase)
  if (phaseList)
    state.byPhase.set(
      handle.phase,
      phaseList.filter((h) => h !== handle)
    )
  handle.dispose?.()
}

export const reorderSystem = (
  world: World,
  handle: SystemHandle,
  ordering: { before?: string[]; after?: string[] }
): void => {
  ;(handle.definition as { before?: string[]; after?: string[] }).before = ordering.before ?? handle.definition.before
  ;(handle.definition as { before?: string[]; after?: string[] }).after = ordering.after ?? handle.definition.after
  const state = schedulers.get(world)
  if (!state) return
  const phaseList = state.byPhase.get(handle.phase) ?? []
  state.byPhase.set(handle.phase, sortPhase(phaseList))
}

export const listSystems = (world: World, phase?: Phase): SystemHandle[] => {
  const state = schedulers.get(world)
  if (!state) return []
  if (phase) return state.byPhase.get(phase)?.slice() ?? []
  return Array.from(state.all)
}

// ── Frame runner ──────────────────────────────────────────────────────────────

/**
 * Drive one frame of the world: phase-ordered system execution + end-of-tick
 * mutation flushes.
 *
 * Phase order: Input → Simulation (fixed substeps) → Animation → Render.
 * After Render: flushRuntime + flushAuthored broadcast pending mutations.
 */
export const runSystems = (world: World, deltaSeconds: number): void => {
  const state = getOrCreate(world)
  const runPhase = (phase: Phase, dt: number): void => {
    for (const handle of state.byPhase.get(phase) ?? []) {
      handle.definition.execute?.(world, dt)
    }
  }
  // Input runs once per frame (variable)
  runPhase('Input', deltaSeconds)
  // tickWorld drives Simulation in fixed substeps, then variable phases
  tickWorld(world, deltaSeconds, {
    fixed: () => runPhase('Simulation', world.fixedTimeStep),
    variable: () => {
      runPhase('Animation', deltaSeconds)
      runPhase('Render', deltaSeconds)
    }
  })
  // End of frame: emit accumulated mutations
  flushRuntime(world)
  flushAuthored(world)
}

/** Dispose all systems on a world (called by destroyWorld via a hook). */
export const disposeAllSystems = (world: World): void => {
  const state = schedulers.get(world)
  if (!state) return
  for (const h of state.all) h.dispose?.()
  schedulers.delete(world)
}
