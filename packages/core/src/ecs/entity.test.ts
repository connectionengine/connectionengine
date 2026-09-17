import { describe, expect, it } from 'vitest'
import { createEngine } from './engine'
import { createAnonAgent, createWorld, destroyWorld } from './world'
import { createEntity, removeEntity, entityExists } from './entity'

describe('Entity', () => {
  it('creates and removes entities, reporting existence', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const e = createEntity(world)
    expect(typeof e).toBe('number')
    expect(entityExists(world, e)).toBe(true)
    removeEntity(world, e)
    expect(entityExists(world, e)).toBe(false)
    destroyWorld(world)
  })

  it('issues unique entity IDs', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const ids = new Set<number>()
    for (let i = 0; i < 100; i++) ids.add(createEntity(world))
    expect(ids.size).toBe(100)
    destroyWorld(world)
  })
})
