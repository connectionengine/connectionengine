import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createComputed, createSignal, createRoot, onCleanup } from 'solid-js'
import { createAnonAgent, createWorld, destroyWorld } from './world'
import { initEngine, resetEngine } from './engine'
import { defineSystem, injectSystem, listSystems, removeSystem, reorderSystem, runSystems } from './system'

beforeEach(() => initEngine())
afterEach(() => resetEngine())

describe('System scheduler', () => {
  it('runs systems in phase order: Input → Simulation → Animation → Render', () => {
    initEngine({ fixedTimeStep: 1 / 60 })
    const world = createWorld({ agent: createAnonAgent() })
    const calls: string[] = []
    defineSystem({ name: 'render', phase: 'Render', execute: () => calls.push('render') })
    defineSystem({ name: 'sim', phase: 'Simulation', execute: () => calls.push('sim') })
    defineSystem({ name: 'input', phase: 'Input', execute: () => calls.push('input') })
    defineSystem({ name: 'anim', phase: 'Animation', execute: () => calls.push('anim') })
    runSystems(1 / 60)
    // input runs once, sim once (1 substep at 1/60), anim once, render once
    expect(calls).toEqual(['input', 'sim', 'anim', 'render'])
    destroyWorld(world)
    resetEngine()
  })

  it('Simulation phase runs N times per frame at fixed timestep', () => {
    initEngine({ fixedTimeStep: 1 / 60 })
    const world = createWorld({ agent: createAnonAgent() })
    let count = 0
    defineSystem({ name: 'sim', phase: 'Simulation', execute: () => count++ })
    runSystems(4 / 60) // 4 substeps
    expect(count).toBe(4)
    destroyWorld(world)
    resetEngine()
  })

  it('orders within phase by before/after constraints', () => {
    const world = createWorld({ agent: createAnonAgent() })
    const calls: string[] = []
    defineSystem({ name: 'middle', phase: 'Render', execute: () => calls.push('middle') })
    defineSystem({ name: 'last', phase: 'Render', after: ['middle'], execute: () => calls.push('last') })
    defineSystem({ name: 'first', phase: 'Render', before: ['middle'], execute: () => calls.push('first') })
    runSystems(0)
    expect(calls).toEqual(['first', 'middle', 'last'])
    destroyWorld(world)
    resetEngine()
  })

  it('removeSystem stops execution and disposes reactor', () => {
    const world = createWorld({ agent: createAnonAgent() })
    let count = 0
    const handle = defineSystem({ name: 's', phase: 'Render', execute: () => count++ })
    runSystems(0)
    expect(count).toBe(1)
    removeSystem(handle)
    runSystems(0)
    expect(count).toBe(1)
    destroyWorld(world)
    resetEngine()
  })

  it('reactor: mounts a Solid reactive root and tears down on removeSystem', () => {
    const world = createWorld({ agent: createAnonAgent() })
    let mounted = false
    let disposed = false
    const handle = defineSystem({
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
    removeSystem(handle)
    expect(disposed).toBe(true)
    destroyWorld(world)
    resetEngine()
  })

  it('reactor: Solid signal updates propagate synchronously via createComputed', async () => {
    // Vitest resolves solid-js to the server build (stub reactivity) under the
    // 'node' export condition. Import the dev build directly to verify real
    // reactive propagation.
    const { createRoot: root, createSignal: signal, createComputed: computed } = await import('solid-js/dist/dev.js')
    let observed = 0
    let setter: ((v: number) => void) | undefined
    const dispose = root((d: () => void) => {
      const [val, set] = signal(0)
      setter = set
      computed(() => {
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
    const world = createWorld({ agent: createAnonAgent() })
    defineSystem({ name: 'a', phase: 'Render' })
    defineSystem({ name: 'b', phase: 'Simulation' })
    expect(
      listSystems()
        .map((h) => h.name)
        .sort()
    ).toEqual(['a', 'b'])
    expect(listSystems('Render').map((h) => h.name)).toEqual(['a'])
    destroyWorld(world)
    resetEngine()
  })

  it('reorderSystem updates ordering at runtime', () => {
    const world = createWorld({ agent: createAnonAgent() })
    const calls: string[] = []
    defineSystem({ name: 'a', phase: 'Render', execute: () => calls.push('a') })
    const b = defineSystem({ name: 'b', phase: 'Render', execute: () => calls.push('b') })
    runSystems(0)
    expect(calls).toEqual(['a', 'b'])
    calls.length = 0
    reorderSystem(b, { before: ['a'] })
    runSystems(0)
    expect(calls).toEqual(['b', 'a'])
    destroyWorld(world)
    resetEngine()
  })

  it('injectSystem re-attaches a removed system, re-mounts its reactor', () => {
    const world = createWorld({ agent: createAnonAgent() })
    let executeCalls = 0
    let mountCount = 0
    let disposeCount = 0
    const handle = defineSystem({
      name: 'plugin',
      phase: 'Simulation',
      execute: () => executeCalls++,
      reactor: () => {
        mountCount++
        onCleanup(() => disposeCount++)
      }
    })
    expect(mountCount).toBe(1)
    runSystems(1 / 60)
    expect(executeCalls).toBe(1)

    removeSystem(handle)
    expect(disposeCount).toBe(1)
    runSystems(1 / 60)
    expect(executeCalls).toBe(1) // no longer running

    injectSystem(handle)
    expect(mountCount).toBe(2) // reactor re-mounted fresh
    runSystems(1 / 60)
    expect(executeCalls).toBe(2)
    destroyWorld(world)
    resetEngine()
  })

  it('injectSystem handles already-injected handles without error', () => {
    const world = createWorld({ agent: createAnonAgent() })
    const handle = defineSystem({ name: 'idem', phase: 'Render', execute: () => {} })
    expect(() => injectSystem(handle)).not.toThrow()
    expect(listSystems().filter((h) => h.name === 'idem')).toHaveLength(1)
    destroyWorld(world)
    resetEngine()
  })

  it('injectSystem throws if a different system already uses the name', () => {
    const world = createWorld({ agent: createAnonAgent() })
    defineSystem({ name: 'duplicate', phase: 'Render', execute: () => {} })
    const otherHandle = defineSystem({ name: 'duplicate', phase: 'Render', execute: () => {} })
    removeSystem(otherHandle)
    expect(() => injectSystem(otherHandle)).toThrow(/already exists/i)
    destroyWorld(world)
  })

  it('throws on circular before/after constraints', () => {
    const world = createWorld({ agent: createAnonAgent() })
    defineSystem({ name: 'cyc-a', phase: 'Render', before: ['cyc-b'] })
    defineSystem({ name: 'cyc-b', phase: 'Render', before: ['cyc-c'] })
    expect(() => defineSystem({ name: 'cyc-c', phase: 'Render', before: ['cyc-a'] })).toThrow(/cycle/i)
    destroyWorld(world)
    resetEngine()
  })

  it('resetEngine disposes all system reactors', () => {
    const world = createWorld({ agent: createAnonAgent() })
    let disposed = false
    defineSystem({
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
    resetEngine()
    expect(disposed).toBe(true)
  })
})
