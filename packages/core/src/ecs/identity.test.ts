import { describe, expect, it } from 'vitest'
import { createEngine } from '../ecs/engine'
import { createAnonAgent, createWorld, destroyWorld } from '../ecs/world'
import { createEntity, removeEntity } from '../ecs/entity'
import { UIDComponent, getEntityByUID, getEntityPath, getParent, getUID, resolveEntityPath, setUID } from './entity'
import { hasComponent } from '../ecs/component'
import type { Entity, World } from '../ecs/world'

// Pure-ECS test helper — createEntity + setUID, no networking. The user-facing
// equivalent (with owner + authority) is `spawnPrefab` in the network layer.
const named = (world: World, uid: string, parent?: Entity): Entity => {
  const e = createEntity(world)
  setUID(world, e, uid, parent !== undefined ? { parent } : undefined)
  return e
}

describe('Identity — UID + BelongsTo', () => {
  it('createEntity + setUID assigns UID + registers in root cache', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const scene = named(world, 'scene:main')
    expect(getUID(world, scene)).toBe('scene:main')
    expect(getEntityByUID(world, world.worldRoot, 'scene:main')).toBe(scene)
    expect(hasComponent(world, scene, UIDComponent)).toBe(true)
    destroyWorld(world)
  })

  it('setUID attaches UID + BelongsTo and indexes under parent', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const scene = named(world, 'scene:main')
    const avatar = createEntity(world)
    setUID(world, avatar, 'avatar:alice', { parent: scene })
    expect(getEntityByUID(world, scene, 'avatar:alice')).toBe(avatar)
    expect(getParent(world, avatar)).toBe(scene)
    destroyWorld(world)
  })

  it('rejects duplicate UID under the same parent', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const scene = named(world, 'scene:main')
    const a = createEntity(world)
    setUID(world, a, 'avatar:x', { parent: scene })
    const b = createEntity(world)
    expect(() => setUID(world, b, 'avatar:x', { parent: scene })).toThrow(/duplicate/i)
    destroyWorld(world)
  })

  it('same UID under different parents is allowed', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const s1 = named(world, 'scene:a')
    const s2 = named(world, 'scene:b')
    const a = createEntity(world)
    const b = createEntity(world)
    setUID(world, a, 'avatar:x', { parent: s1 })
    setUID(world, b, 'avatar:x', { parent: s2 })
    expect(getEntityByUID(world, s1, 'avatar:x')).toBe(a)
    expect(getEntityByUID(world, s2, 'avatar:x')).toBe(b)
    destroyWorld(world)
  })

  it('getEntityPath walks BelongsTo chain', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const scene = named(world, 'scene:main')
    const model = createEntity(world)
    setUID(world, model, 'model:knight', { parent: scene })
    const bone = createEntity(world)
    setUID(world, bone, 'bone:spine', { parent: model })
    expect(getEntityPath(world, bone)).toEqual(['scene:main', 'model:knight', 'bone:spine'])
    destroyWorld(world)
  })

  it('resolveEntityPath inverts getEntityPath', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const scene = named(world, 'scene:main')
    const model = createEntity(world)
    setUID(world, model, 'model:knight', { parent: scene })
    const bone = createEntity(world)
    setUID(world, bone, 'bone:spine', { parent: model })
    const path = getEntityPath(world, bone)
    expect(resolveEntityPath(world, path)).toBe(bone)
    expect(resolveEntityPath(world, ['nonexistent'])).toBeUndefined()
    destroyWorld(world)
  })

  it('removeEntity eventually clears identity caches (via observers)', async () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const scene = named(world, 'scene:main')
    const avatar = createEntity(world)
    setUID(world, avatar, 'avatar:alice', { parent: scene })
    expect(getEntityByUID(world, scene, 'avatar:alice')).toBe(avatar)
    removeEntity(world, avatar)
    const found = getEntityByUID(world, scene, 'avatar:alice')
    expect(found === undefined || found !== avatar).toBe(true)
    destroyWorld(world)
  })

  it('BelongsTo is exclusive (re-parent replaces)', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const a = named(world, 'scene:a')
    const b = named(world, 'scene:b')
    const e = createEntity(world)
    setUID(world, e, 'avatar:x', { parent: a })
    expect(getParent(world, e)).toBe(a)
    setUID(world, e, 'avatar:x', { parent: b })
    expect(getParent(world, e)).toBe(b)
    expect(getEntityByUID(world, a, 'avatar:x')).toBeUndefined()
    expect(getEntityByUID(world, b, 'avatar:x')).toBe(e)
    destroyWorld(world)
  })
})
