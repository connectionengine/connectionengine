import { describe, expect, it } from 'vitest'
import { Worlds, createAnonAgent, createWorld, destroyWorld, tickWorld } from './world'
import { createManualClock } from './clock'

describe('World', () => {
  it('initialises with default time state and empty bindings', () => {
    const world = createWorld({ agent: createAnonAgent() })
    expect(world.frameTime).toBe(0)
    expect(world.simulationTime).toBe(0)
    expect(world.fixedTimeStep).toBeCloseTo(1 / 60)
    expect(world.deltaSeconds).toBe(0)
    expect(world.accumulator).toBe(0)
    expect(world.network.connections.size).toBe(0)
    expect(world.network.schemas.size).toBe(0)
    expect(world.eventLog).toEqual([])
    expect(world.authoredQueue).toEqual([])
    expect(world.runtimeDirty.size).toBe(0)
    expect(Worlds.has(world)).toBe(true)
    destroyWorld(world)
  })

  it('respects custom fixedTimeStep, clock, and trace sink', () => {
    const clock = createManualClock(1000)
    const world = createWorld({ agent: createAnonAgent(), fixedTimeStep: 1 / 30, clock })
    expect(world.fixedTimeStep).toBeCloseTo(1 / 30)
    expect(world.clock.now()).toBe(1000)
    clock.advance(50)
    expect(world.clock.now()).toBe(1050)
    destroyWorld(world)
  })

  it('isolates state across multiple worlds', () => {
    const a = createWorld({ agent: createAnonAgent() })
    const b = createWorld({ agent: createAnonAgent() })
    expect(a).not.toBe(b)
    expect(Worlds.has(a) && Worlds.has(b)).toBe(true)
    destroyWorld(a)
    expect(Worlds.has(a)).toBe(false)
    expect(Worlds.has(b)).toBe(true)
    destroyWorld(b)
  })

  it('destroyWorld is idempotent and clears bindings', () => {
    const world = createWorld({ agent: createAnonAgent() })
    world.network.schemas.set('X', { id: 'X', jsonSchema: {}, shaclShape: {}, mutationCategory: 'authored' })
    destroyWorld(world)
    expect(world.network.schemas.size).toBe(0)
    expect(Worlds.has(world)).toBe(false)
    // calling again is a noop
    destroyWorld(world)
    expect(Worlds.has(world)).toBe(false)
  })
})

describe('tickWorld', () => {
  it('drives fixed substeps in Simulation phase, runs variable once per frame', () => {
    const world = createWorld({ agent: createAnonAgent(), fixedTimeStep: 1 / 60 })
    let fixedCount = 0
    let varCount = 0
    // 4 frames of 1/30s — should run 2 fixed substeps per frame
    for (let i = 0; i < 4; i++) {
      tickWorld(world, 1 / 30, {
        fixed: () => fixedCount++,
        variable: () => varCount++
      })
    }
    expect(fixedCount).toBe(8) // 4 frames * 2 substeps
    expect(varCount).toBe(4)
    expect(world.simulationTime).toBeCloseTo(8 * (1 / 60))
    destroyWorld(world)
  })

  it('accumulates leftover time without dropping substeps', () => {
    const world = createWorld({ agent: createAnonAgent(), fixedTimeStep: 1 / 60 })
    let fixed = 0
    // 1/120s — under fixed step; no substep yet
    tickWorld(world, 1 / 120, { fixed: () => fixed++, variable: () => {} })
    expect(fixed).toBe(0)
    // another 1/120s — now total is 1/60, one substep
    tickWorld(world, 1 / 120, { fixed: () => fixed++, variable: () => {} })
    expect(fixed).toBe(1)
    destroyWorld(world)
  })

  it('runs no fixed substeps when frame time is zero', () => {
    const world = createWorld({ agent: createAnonAgent() })
    let fixed = 0
    let variable = 0
    tickWorld(world, 0, { fixed: () => fixed++, variable: () => variable++ })
    expect(fixed).toBe(0)
    expect(variable).toBe(1)
    destroyWorld(world)
  })
})
