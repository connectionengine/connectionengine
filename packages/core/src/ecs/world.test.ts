import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAnonAgent, createWorld, destroyWorld } from './world'
import { initEngine, resetEngine, getEngine, tickEngine } from './engine'
import { createManualClock } from './clock'

beforeEach(() => initEngine())
afterEach(() => resetEngine())

describe('World', () => {
  it('initialises with default time state on the engine and empty bindings', () => {
    const world = createWorld({ agent: createAnonAgent() })
    expect(world.engine.frameTime).toBe(0)
    expect(world.engine.simulationTime).toBe(0)
    expect(world.engine.fixedTimeStep).toBeCloseTo(1 / 60)
    expect(world.engine.deltaSeconds).toBe(0)
    expect(world.engine.accumulator).toBe(0)
    expect(world.eventLog).toEqual([])
    expect(world.componentDirty.size).toBe(0)
    expect(world.relationQueue).toEqual([])
    expect(world.destroyQueue).toEqual([])
    expect(world.runtimeDirty.size).toBe(0)
    destroyWorld(world)
  })

  it('respects custom fixedTimeStep and clock at engine construction', () => {
    const clock = createManualClock(1000)
    initEngine({ fixedTimeStep: 1 / 30, clock })
    const world = createWorld({ agent: createAnonAgent() })
    expect(world.engine.fixedTimeStep).toBeCloseTo(1 / 30)
    expect(world.engine.clock.now()).toBe(1000)
    clock.advance(50)
    expect(world.engine.clock.now()).toBe(1050)
    destroyWorld(world)
  })

  it('worlds share the singleton engine', () => {
    const a = createWorld({ agent: createAnonAgent() })
    const b = createWorld({ agent: createAnonAgent() })
    expect(a).not.toBe(b)
    expect(a.engine).toBe(b.engine)
    destroyWorld(a)
    // b remains usable after a goes away
    expect(b.eventLog).toBeDefined()
    destroyWorld(b)
  })

  it('destroyWorld is idempotent', () => {
    const world = createWorld({ agent: createAnonAgent() })
    destroyWorld(world)
    // calling again does not throw
    expect(() => destroyWorld(world)).not.toThrow()
  })
})

describe('tickEngine', () => {
  it('drives fixed substeps in Simulation phase, runs variable once per frame', () => {
    initEngine({ fixedTimeStep: 1 / 60 })
    let fixedCount = 0
    let varCount = 0
    // 4 frames of 1/30s — should run 2 fixed substeps per frame
    for (let i = 0; i < 4; i++) {
      tickEngine(getEngine(), 1 / 30, {
        fixed: () => fixedCount++,
        variable: () => varCount++
      })
    }
    expect(fixedCount).toBe(8) // 4 frames * 2 substeps
    expect(varCount).toBe(4)
    expect(getEngine().simulationTime).toBeCloseTo(8 * (1 / 60))
  })

  it('accumulates leftover time without dropping substeps', () => {
    initEngine({ fixedTimeStep: 1 / 60 })
    let fixed = 0
    // 1/120s — under the fixed step, so no substep yet
    tickEngine(getEngine(), 1 / 120, { fixed: () => fixed++, variable: () => {} })
    expect(fixed).toBe(0)
    // another 1/120s — now total is 1/60, one substep
    tickEngine(getEngine(), 1 / 120, { fixed: () => fixed++, variable: () => {} })
    expect(fixed).toBe(1)
  })

  it('runs no fixed substeps when frame time is zero', () => {
    let fixed = 0
    let variable = 0
    tickEngine(getEngine(), 0, { fixed: () => fixed++, variable: () => variable++ })
    expect(fixed).toBe(0)
    expect(variable).toBe(1)
  })
})
