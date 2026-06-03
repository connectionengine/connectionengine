import { describe, expect, it } from 'vitest'
import { createAnonAgent, createWorld, destroyWorld } from './world'
import { createEntity, removeEntity, entityExists } from './entity'

describe('Entity', () => {
  it('creates and removes entities, reporting existence', () => {
    const world = createWorld({ agent: createAnonAgent() })
    const e = createEntity(world)
    expect(typeof e).toBe('number')
    expect(entityExists(world, e)).toBe(true)
    removeEntity(world, e)
    expect(entityExists(world, e)).toBe(false)
    destroyWorld(world)
  })

  it('emits trace events on create + remove', () => {
    const world = createWorld({ agent: createAnonAgent() })
    const e = createEntity(world)
    expect(world.trace.byKind('entity.create')).toHaveLength(1)
    expect(world.trace.byKind('entity.create')[0].entity).toBe(e)
    removeEntity(world, e)
    expect(world.trace.byKind('entity.remove')).toHaveLength(1)
    destroyWorld(world)
  })

  it('silent option suppresses trace emission', () => {
    const world = createWorld({ agent: createAnonAgent() })
    const e = createEntity(world, { silent: true })
    expect(world.trace.byKind('entity.create')).toHaveLength(0)
    removeEntity(world, e, { silent: true })
    expect(world.trace.byKind('entity.remove')).toHaveLength(0)
    destroyWorld(world)
  })

  it('issues unique entity IDs', () => {
    const world = createWorld({ agent: createAnonAgent() })
    const ids = new Set<number>()
    for (let i = 0; i < 100; i++) ids.add(createEntity(world))
    expect(ids.size).toBe(100)
    destroyWorld(world)
  })
})
