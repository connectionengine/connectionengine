import { describe, expect, it } from 'vitest'
import { Schema } from '../schema'
import { defineComponent, getComponent, hasComponent } from '../ecs/component'
import { createAnonAgent, createWorld, destroyWorld, type World } from '../ecs/world'
import { createEngine } from '../ecs/engine'
import { getEntityByUID, getUID } from '../ecs/entity'
import { definePrefab, spawnPrefab } from './prefab'
import { getAuthority, getOwner } from './authority'
import { createPeer, createUser } from './peer'

/** Bootstrap a local user + peer so spawnPrefab has defaults to draw on. */
const bootstrap = (world: World, name = 'prefab-test') => {
  const user = createUser(world, { did: world.localAgent.did, asLocal: true })
  createPeer(world, { user, peerId: `${name}-p`, asLocal: true })
}

const Transform = defineComponent({
  id: 'Transform-prefab',
  schema: Schema.Object({ position: Schema.Vec3() })
})
const Health = defineComponent({
  id: 'Health-prefab',
  schema: Schema.Object({ current: Schema.Number({ default: 100 }), max: Schema.Number({ default: 100 }) })
})
const Tag = defineComponent({
  id: 'Tag-prefab',
  schema: Schema.Object({ name: Schema.String({ default: '' }) })
})

describe('Prefab', () => {
  it('definePrefab composes ComponentSchema from constituents', () => {
    const Avatar = definePrefab('Avatar', { components: [Transform, Health, Tag] })
    expect(Avatar.components).toHaveLength(3)
    expect(Avatar.composedSchema.id).toBe('prefab:Avatar')
    // The composed jsonSchema keys each constituent by component id.
    expect(Object.keys((Avatar.composedSchema.jsonSchema as { properties: object }).properties)).toEqual([
      Transform.$id,
      Health.$id,
      Tag.$id
    ])
  })
})

describe('spawnPrefab', () => {
  it('without a prefab — spawns a bare networked entity (UID + owner + authority)', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    bootstrap(world)
    const e = spawnPrefab(world, 'scene:bare')
    expect(getUID(world, e)).toBe('scene:bare')
    expect(getOwner(world, e)).toBe(world.localUser)
    expect(getAuthority(world, e)).toBe(world.localPeer)
    expect(hasComponent(world, e, Health)).toBe(false)
    destroyWorld(world)
  })

  it('with a prefab — attaches all components with defaults', () => {
    const Avatar = definePrefab('Avatar2', { components: [Health, Tag] })
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    bootstrap(world)
    const e = spawnPrefab(world, 'avatar:1', { prefab: Avatar })
    expect(hasComponent(world, e, Health)).toBe(true)
    expect(hasComponent(world, e, Tag)).toBe(true)
    expect(getComponent(world, e, Health)).toEqual({ current: 100, max: 100 })
    destroyWorld(world)
  })

  it('prefab defaults merge under per-instance overrides', () => {
    const Boss = definePrefab('Boss', {
      components: [Health],
      defaults: { 'Health-prefab': { current: 999, max: 999 } }
    })
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    bootstrap(world)
    const e1 = spawnPrefab(world, 'boss:1', { prefab: Boss })
    expect(getComponent(world, e1, Health)).toEqual({ current: 999, max: 999 })
    const e2 = spawnPrefab(world, 'boss:2', {
      prefab: Boss,
      overrides: { 'Health-prefab': { current: 1 } }
    })
    expect(getComponent(world, e2, Health)).toEqual({ current: 1, max: 999 })
    destroyWorld(world)
  })

  it('places under an explicit parent', () => {
    const Avatar = definePrefab('Avatar3', { components: [Tag] })
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    bootstrap(world)
    const scene = spawnPrefab(world, 'scene:prefabs')
    const e = spawnPrefab(world, 'alice', { prefab: Avatar, parent: scene })
    expect(getUID(world, e)).toBe('alice')
    expect(getEntityByUID(world, scene, 'alice')).toBe(e)
    destroyWorld(world)
  })

  it('throws when no owner can be determined', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent('lonely') })
    // No createUser / createPeer — world.localUser is undefined.
    expect(() => spawnPrefab(world, 'will-fail')).toThrow(/no owner provided/i)
    destroyWorld(world)
  })

  it('explicit owner option overrides the world default', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    bootstrap(world)
    const other = createUser(world, { did: 'did:test:other' })
    const e = spawnPrefab(world, 'thing', { owner: other })
    expect(getOwner(world, e)).toBe(other)
  })
})
