import { describe, expect, it, vi } from 'vitest'
import { createEngine } from '../ecs/engine'
import { createAnonAgent, createWorld, destroyWorld } from '../ecs/world'
import { createEntity, removeEntity } from '../ecs/entity'
import { BelongsTo, UIDComponent, getEntityByUID, getEntityPath, resolveEntityPath, setUID, uidOfFor } from './entity'
import { hasRelation } from '../ecs/relation'
import { hasComponent, setComponent } from '../ecs/component'
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
    expect(UIDComponent.get(world, scene)).toBe('scene:main')
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
    expect(BelongsTo.get(world, avatar)).toBe(scene)
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
    expect(BelongsTo.get(world, e)).toBe(a)
    setUID(world, e, 'avatar:x', { parent: b })
    expect(BelongsTo.get(world, e)).toBe(b)
    expect(getEntityByUID(world, a, 'avatar:x')).toBeUndefined()
    expect(getEntityByUID(world, b, 'avatar:x')).toBe(e)
    destroyWorld(world)
  })
})

describe('identity accessors on the definitions', () => {
  it('BelongsTo.get answers for a top-level entity, which carries no edge', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent('top') })
    const top = createEntity(world)
    setUID(world, top, 'top-level')
    // No BelongsTo edge replicates for a top-level entity — `worldRoot` is
    // local to each peer — but the index still names the parent, so path
    // walking and cache invalidation both work.
    expect(hasRelation(world, top, BelongsTo, world.worldRoot)).toBe(false)
    expect(BelongsTo.get(world, top)).toBe(world.worldRoot)

    const child = createEntity(world)
    setUID(world, child, 'child', { parent: top })
    expect(hasRelation(world, child, BelongsTo, top)).toBe(true)
    expect(BelongsTo.get(world, child)).toBe(top)
    destroyWorld(world)
  })

  it('UIDComponent.get falls back to component storage when the index is cold', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent('cold') })
    const e = createEntity(world)
    setUID(world, e, 'named')
    expect(UIDComponent.get(world, e)).toBe('named')

    // A write that bypasses `setUID` leaves the index without an entry. The
    // component still holds the value, so the accessor still answers.
    const bare = createEntity(world)
    setComponent(world, bare, UIDComponent, { value: 'bypassed' })
    expect(uidOfFor(world.engine).has(bare)).toBe(false)
    expect(UIDComponent.get(world, bare)).toBe('bypassed')
    destroyWorld(world)
  })
})

describe('module initialisation order', () => {
  it('evaluates entity.ts with no module-scope use of its own accessors', async () => {
    // `UIDComponent.get` and the accessors name each other, so the module holds
    // a reference cycle that only resolves at call time. `resetModules` forces
    // a real re-evaluation rather than reusing the loaded copy, so an import
    // that throws — a module-scope call added above a declaration, say — fails
    // here instead of somewhere downstream.
    vi.resetModules()
    const fresh = await import('./entity')

    // Reachable and working straight after evaluation, before anything else
    // touches the module.
    const engine = createEngine()
    expect(fresh.uidOfFor(engine)).toBeInstanceOf(Map)
    expect(fresh.nameCacheFor(engine)).toBeInstanceOf(Map)
    expect(typeof fresh.UIDComponent.get).toBe('function')
  })
})
