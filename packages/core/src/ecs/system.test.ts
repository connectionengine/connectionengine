import { describe, expect, it } from 'vitest'
import { createComputed, createSignal, createRoot, onCleanup } from 'solid-js'
import { createAnonAgent, createWorld, destroyWorld } from './world'
import { createEngine, destroyEngine } from './engine'
import { defineSystem, injectSystem, listSystems, removeSystem, reorderSystem, runSystems } from './system'

describe('System scheduler', () => {
  it('runs systems in phase order: Input → Simulation → Animation → Render', () => {
    const engine = createEngine({ fixedTimeStep: 1 / 60 })
    const world = createWorld({ engine, agent: createAnonAgent() })
    const calls: string[] = []
    defineSystem(engine, { name: 'render', phase: 'Render', execute: () => calls.push('render') })
    defineSystem(engine, { name: 'sim', phase: 'Simulation', execute: () => calls.push('sim') })
    defineSystem(engine, { name: 'input', phase: 'Input', execute: () => calls.push('input') })
    defineSystem(engine, { name: 'anim', phase: 'Animation', execute: () => calls.push('anim') })
    runSystems(engine, 1 / 60)
    // input runs once, sim once (1 substep at 1/60), anim once, render once
    expect(calls).toEqual(['input', 'sim', 'anim', 'render'])
    destroyWorld(world)
    destroyEngine(engine)
  })

  it('Simulation phase runs N times per frame at fixed timestep', () => {
    const engine = createEngine({ fixedTimeStep: 1 / 60 })
    const world = createWorld({ engine, agent: createAnonAgent() })
    let count = 0
    defineSystem(engine, { name: 'sim', phase: 'Simulation', execute: () => count++ })
    runSystems(engine, 4 / 60) // 4 substeps
    expect(count).toBe(4)
    destroyWorld(world)
    destroyEngine(engine)
  })

  it('orders within phase by before/after constraints', () => {
    const engine = createEngine()
    const world = createWorld({ engine, agent: createAnonAgent() })
    const calls: string[] = []
    defineSystem(engine, { name: 'middle', phase: 'Render', execute: () => calls.push('middle') })
    defineSystem(engine, { name: 'last', phase: 'Render', after: ['middle'], execute: () => calls.push('last') })
    defineSystem(engine, { name: 'first', phase: 'Render', before: ['middle'], execute: () => calls.push('first') })
    runSystems(engine, 0)
    expect(calls).toEqual(['first', 'middle', 'last'])
    destroyWorld(world)
    destroyEngine(engine)
  })

  it('removeSystem stops execution and disposes reactor', () => {
    const engine = createEngine()
    const world = createWorld({ engine, agent: createAnonAgent() })
    let count = 0
    const handle = defineSystem(engine, { name: 's', phase: 'Render', execute: () => count++ })
    runSystems(engine, 0)
    expect(count).toBe(1)
    removeSystem(engine, handle)
    runSystems(engine, 0)
    expect(count).toBe(1)
    destroyWorld(world)
    destroyEngine(engine)
  })

  it('reactor: mounts a Solid reactive root and tears down on removeSystem', () => {
    const engine = createEngine()
    const world = createWorld({ engine, agent: createAnonAgent() })
    let mounted = false
    let disposed = false
    const handle = defineSystem(engine, {
      name: 'reactive',
      phase: 'Simulation',
      reactor: () => {
        mounted = true
        onCleanup(() => {
          disposed = true
        })
      }
    })
    expect(mounted).toBe(true)
    expect(disposed).toBe(false)
    removeSystem(engine, handle)
    expect(disposed).toBe(true)
    destroyWorld(world)
    destroyEngine(engine)
  })

  it('reactor: Solid signal updates propagate synchronously via createComputed', () => {
    let observed = 0
    let setter: ((v: number) => void) | undefined
    const dispose = createRoot((d) => {
      const [val, set] = createSignal(0)
      setter = set
      createComputed(() => {
        observed = val()
      })
      return d
    })
    expect(observed).toBe(0)
    setter?.(42)
    expect(observed).toBe(42)
    dispose()
  })

  it('listSystems enumerates by phase or all', () => {
    const engine = createEngine()
    const world = createWorld({ engine, agent: createAnonAgent() })
    defineSystem(engine, { name: 'a', phase: 'Render' })
    defineSystem(engine, { name: 'b', phase: 'Simulation' })
    expect(
      listSystems(engine)
        .map((h) => h.name)
        .sort()
    ).toEqual(['a', 'b'])
    expect(listSystems(engine, 'Render').map((h) => h.name)).toEqual(['a'])
    destroyWorld(world)
    destroyEngine(engine)
  })

  it('reorderSystem updates ordering at runtime', () => {
    const engine = createEngine()
    const world = createWorld({ engine, agent: createAnonAgent() })
    const calls: string[] = []
    defineSystem(engine, { name: 'a', phase: 'Render', execute: () => calls.push('a') })
    const b = defineSystem(engine, { name: 'b', phase: 'Render', execute: () => calls.push('b') })
    runSystems(engine, 0)
    expect(calls).toEqual(['a', 'b'])
    calls.length = 0
    reorderSystem(engine, b, { before: ['a'] })
    runSystems(engine, 0)
    expect(calls).toEqual(['b', 'a'])
    destroyWorld(world)
    destroyEngine(engine)
  })

  it('injectSystem re-attaches a removed system, re-mounts its reactor', () => {
    const engine = createEngine()
    const world = createWorld({ engine, agent: createAnonAgent() })
    let executeCalls = 0
    let mountCount = 0
    let disposeCount = 0
    const handle = defineSystem(engine, {
      name: 'plugin',
      phase: 'Simulation',
      execute: () => executeCalls++,
      reactor: () => {
        mountCount++
        onCleanup(() => disposeCount++)
      }
    })
    expect(mountCount).toBe(1)
    runSystems(engine, 1 / 60)
    expect(executeCalls).toBe(1)

    removeSystem(engine, handle)
    expect(disposeCount).toBe(1)
    runSystems(engine, 1 / 60)
    expect(executeCalls).toBe(1) // no longer running

    injectSystem(engine, handle)
    expect(mountCount).toBe(2) // reactor re-mounted fresh
    runSystems(engine, 1 / 60)
    expect(executeCalls).toBe(2)
    destroyWorld(world)
    destroyEngine(engine)
  })

  it('injectSystem handles already-injected handles without error', () => {
    const engine = createEngine()
    const world = createWorld({ engine, agent: createAnonAgent() })
    const handle = defineSystem(engine, { name: 'idem', phase: 'Render', execute: () => {} })
    expect(() => injectSystem(engine, handle)).not.toThrow()
    expect(listSystems(engine).filter((h) => h.name === 'idem')).toHaveLength(1)
    destroyWorld(world)
    destroyEngine(engine)
  })

  it('injectSystem throws if a different system already uses the name', () => {
    const engineA = createEngine()
    const worldA = createWorld({ engine: engineA, agent: createAnonAgent() })
    defineSystem(engineA, { name: 'duplicate', phase: 'Render', execute: () => {} })
    const engineB = createEngine()
    const worldB = createWorld({ engine: engineB, agent: createAnonAgent() })
    const otherHandle = defineSystem(engineB, { name: 'duplicate', phase: 'Render', execute: () => {} })
    removeSystem(engineB, otherHandle)
    expect(() => injectSystem(engineA, otherHandle)).toThrow(/already exists/i)
    destroyWorld(worldA)
    destroyWorld(worldB)
    destroyEngine(engineA)
    destroyEngine(engineB)
  })

  it('destroyEngine disposes all system reactors', () => {
    const engine = createEngine()
    const world = createWorld({ engine, agent: createAnonAgent() })
    let disposed = false
    defineSystem(engine, {
      name: 'lifecycle',
      phase: 'Simulation',
      reactor: () => {
        onCleanup(() => {
          disposed = true
        })
      }
    })
    expect(disposed).toBe(false)
    destroyWorld(world)
    // destroyWorld does NOT dispose systems — they belong to the engine.
    expect(disposed).toBe(false)
    destroyEngine(engine)
    expect(disposed).toBe(true)
  })
})
