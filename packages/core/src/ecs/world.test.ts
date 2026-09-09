import { describe, expect, it } from 'vitest'
import { Worlds, createAnonAgent, createWorld, destroyWorld, tickEngine } from './world'
import { createEngine } from './engine'
import { createManualClock } from './clock'

describe('World', () => {
  it('initialises with default time state on the engine and empty bindings', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    expect(world.engine.frameTime).toBe(0)
    expect(world.engine.simulationTime).toBe(0)
    expect(world.engine.fixedTimeStep).toBeCloseTo(1 / 60)
    expect(world.engine.deltaSeconds).toBe(0)
    expect(world.engine.accumulator).toBe(0)
    expect(world.eventLog).toEqual([])
    expect(world.authoredQueue).toEqual([])
    expect(world.runtimeDirty.size).toBe(0)
    expect(Worlds.has(world)).toBe(true)
    destroyWorld(world)
  })

  it('respects custom fixedTimeStep and clock at engine construction', () => {
    const clock = createManualClock(1000)
    const engine = createEngine({ fixedTimeStep: 1 / 30, clock })
    const world = createWorld({ engine, agent: createAnonAgent() })
    expect(world.engine.fixedTimeStep).toBeCloseTo(1 / 30)
    expect(world.engine.clock.now()).toBe(1000)
    clock.advance(50)
    expect(world.engine.clock.now()).toBe(1050)
    destroyWorld(world)
  })

  it('isolates state across multiple worlds', () => {
    const a = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const b = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    expect(a).not.toBe(b)
    expect(Worlds.has(a) && Worlds.has(b)).toBe(true)
    destroyWorld(a)
    expect(Worlds.has(a)).toBe(false)
    expect(Worlds.has(b)).toBe(true)
    destroyWorld(b)
  })

  it('destroyWorld is idempotent', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    destroyWorld(world)
    expect(Worlds.has(world)).toBe(false)
    // calling again is a noop
    destroyWorld(world)
    expect(Worlds.has(world)).toBe(false)
  })
})

describe('tickEngine', () => {
  it('drives fixed substeps in Simulation phase, runs variable once per frame', () => {
    const engine = createEngine({ fixedTimeStep: 1 / 60 })
    let fixedCount = 0
    let varCount = 0
    // 4 frames of 1/30s — should run 2 fixed substeps per frame
    for (let i = 0; i < 4; i++) {
      tickEngine(engine, 1 / 30, {
        fixed: () => fixedCount++,
        variable: () => varCount++
      })
    }
    expect(fixedCount).toBe(8) // 4 frames * 2 substeps
    expect(varCount).toBe(4)
    expect(engine.simulationTime).toBeCloseTo(8 * (1 / 60))
  })

  it('accumulates leftover time without dropping substeps', () => {
    const engine = createEngine({ fixedTimeStep: 1 / 60 })
    let fixed = 0
    // 1/120s — under the fixed step, so no substep yet
    tickEngine(engine, 1 / 120, { fixed: () => fixed++, variable: () => {} })
    expect(fixed).toBe(0)
    // another 1/120s — now total is 1/60, one substep
    tickEngine(engine, 1 / 120, { fixed: () => fixed++, variable: () => {} })
    expect(fixed).toBe(1)
  })

  it('runs no fixed substeps when frame time is zero', () => {
    const engine = createEngine()
    let fixed = 0
    let variable = 0
    tickEngine(engine, 0, { fixed: () => fixed++, variable: () => variable++ })
    expect(fixed).toBe(0)
    expect(variable).toBe(1)
  })
})
