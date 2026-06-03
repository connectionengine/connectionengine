import { describe, expect, it } from 'vitest'
import { createComputed, createSignal, createRoot, onCleanup } from 'solid-js'
import { createAnonAgent, createWorld, destroyWorld } from '../ecs/world'
import { defineSystem, injectSystem, listSystems, removeSystem, reorderSystem, runSystems } from './system'

describe('System scheduler', () => {
  it('runs systems in phase order: Input → Simulation → Animation → Render', () => {
    const world = createWorld({ agent: createAnonAgent(), fixedTimeStep: 1 / 60 })
    const calls: string[] = []
    defineSystem(world, { name: 'render', phase: 'Render', execute: () => calls.push('render') })
    defineSystem(world, { name: 'sim', phase: 'Simulation', execute: () => calls.push('sim') })
    defineSystem(world, { name: 'input', phase: 'Input', execute: () => calls.push('input') })
    defineSystem(world, { name: 'anim', phase: 'Animation', execute: () => calls.push('anim') })
    runSystems(world, 1 / 60)
    // input runs once, sim once (1 substep at 1/60), anim once, render once
    expect(calls).toEqual(['input', 'sim', 'anim', 'render'])
    destroyWorld(world)
  })

  it('Simulation phase runs N times per frame at fixed timestep', () => {
    const world = createWorld({ agent: createAnonAgent(), fixedTimeStep: 1 / 60 })
    let count = 0
    defineSystem(world, { name: 'sim', phase: 'Simulation', execute: () => count++ })
    runSystems(world, 4 / 60) // 4 substeps
    expect(count).toBe(4)
    destroyWorld(world)
  })

  it('orders within phase by before/after constraints', () => {
    const world = createWorld({ agent: createAnonAgent() })
    const calls: string[] = []
    defineSystem(world, { name: 'middle', phase: 'Render', execute: () => calls.push('middle') })
    defineSystem(world, { name: 'last', phase: 'Render', after: ['middle'], execute: () => calls.push('last') })
    defineSystem(world, { name: 'first', phase: 'Render', before: ['middle'], execute: () => calls.push('first') })
    runSystems(world, 0)
    expect(calls).toEqual(['first', 'middle', 'last'])
    destroyWorld(world)
  })

  it('removeSystem stops execution and disposes reactor', () => {
    const world = createWorld({ agent: createAnonAgent() })
    let count = 0
    const handle = defineSystem(world, { name: 's', phase: 'Render', execute: () => count++ })
    runSystems(world, 0)
    expect(count).toBe(1)
    removeSystem(world, handle)
    runSystems(world, 0)
    expect(count).toBe(1)
    destroyWorld(world)
  })

  it('reactor: mounts a Solid reactive root and tears down on removeSystem', () => {
    const world = createWorld({ agent: createAnonAgent() })
    let mounted = false
    let disposed = false
    const handle = defineSystem(world, {
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
    removeSystem(world, handle)
    expect(disposed).toBe(true)
    destroyWorld(world)
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
    const world = createWorld({ agent: createAnonAgent() })
    defineSystem(world, { name: 'a', phase: 'Render' })
    defineSystem(world, { name: 'b', phase: 'Simulation' })
    expect(
      listSystems(world)
        .map((h) => h.name)
        .sort()
    ).toEqual(['a', 'b'])
    expect(listSystems(world, 'Render').map((h) => h.name)).toEqual(['a'])
    destroyWorld(world)
  })

  it('reorderSystem updates ordering at runtime', () => {
    const world = createWorld({ agent: createAnonAgent() })
    const calls: string[] = []
    defineSystem(world, { name: 'a', phase: 'Render', execute: () => calls.push('a') })
    const b = defineSystem(world, { name: 'b', phase: 'Render', execute: () => calls.push('b') })
    runSystems(world, 0)
    expect(calls).toEqual(['a', 'b'])
    calls.length = 0
    reorderSystem(world, b, { before: ['a'] })
    runSystems(world, 0)
    expect(calls).toEqual(['b', 'a'])
    destroyWorld(world)
  })

  it('injectSystem re-attaches a removed system, re-mounts its reactor', () => {
    const world = createWorld({ agent: createAnonAgent() })
    let executeCalls = 0
    let mountCount = 0
    let disposeCount = 0
    const handle = defineSystem(world, {
      name: 'plugin',
      phase: 'Simulation',
      execute: () => executeCalls++,
      reactor: () => {
        mountCount++
        onCleanup(() => disposeCount++)
      }
    })
    expect(mountCount).toBe(1)
    runSystems(world, 1 / 60)
    expect(executeCalls).toBe(1)

    removeSystem(world, handle)
    expect(disposeCount).toBe(1)
    runSystems(world, 1 / 60)
    expect(executeCalls).toBe(1) // no longer running

    injectSystem(world, handle)
    expect(mountCount).toBe(2) // reactor re-mounted fresh
    runSystems(world, 1 / 60)
    expect(executeCalls).toBe(2)
    destroyWorld(world)
  })

  it('injectSystem is idempotent for already-injected handles', () => {
    const world = createWorld({ agent: createAnonAgent() })
    const handle = defineSystem(world, { name: 'idem', phase: 'Render', execute: () => {} })
    expect(() => injectSystem(world, handle)).not.toThrow()
    expect(listSystems(world).filter((h) => h.name === 'idem')).toHaveLength(1)
    destroyWorld(world)
  })

  it('injectSystem throws if a different system already uses the name', () => {
    const world = createWorld({ agent: createAnonAgent() })
    defineSystem(world, { name: 'duplicate', phase: 'Render', execute: () => {} })
    const otherWorld = createWorld({ agent: createAnonAgent() })
    const otherHandle = defineSystem(otherWorld, { name: 'duplicate', phase: 'Render', execute: () => {} })
    removeSystem(otherWorld, otherHandle)
    expect(() => injectSystem(world, otherHandle)).toThrow(/already injected/i)
    destroyWorld(world)
    destroyWorld(otherWorld)
  })
})
