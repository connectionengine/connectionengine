import { describe, expect, it } from 'vitest'
import { Schema } from '../schema'
import { defineComponent, getComponent, hasComponent } from '../ecs/component'
import { createAnonAgent, createWorld, destroyWorld } from '../ecs/world'
import { definePrefab, instantiatePrefab } from './prefab'
import { createNamedEntity, getEntityByUID, getUID } from '../network/identity'

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
    // Has runtime component (Transform) → composed category is runtime
    expect(Avatar.composedSchema.mutationCategory).toBe('runtime')
  })

  it('instantiatePrefab attaches all components with defaults', () => {
    const Avatar = definePrefab('Avatar2', { components: [Health, Tag] })
    const world = createWorld({ agent: createAnonAgent() })
    const e = instantiatePrefab(world, Avatar)
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
    const world = createWorld({ agent: createAnonAgent() })
    const e1 = instantiatePrefab(world, Boss)
    expect(getComponent(world, e1, Health)).toEqual({ current: 999, max: 999 })
    const e2 = instantiatePrefab(world, Boss, { overrides: { 'Health-prefab': { current: 1 } } })
    expect(getComponent(world, e2, Health)).toEqual({ current: 1, max: 999 })
    destroyWorld(world)
  })

  it('instantiatePrefab assigns UID + parent when provided', () => {
    const Avatar = definePrefab('Avatar3', { components: [Tag] })
    const world = createWorld({ agent: createAnonAgent() })
    const scene = createNamedEntity(world, 'scene:prefabs')
    const e = instantiatePrefab(world, Avatar, { uid: 'alice', parent: scene })
    expect(getUID(world, e)).toBe('alice')
    expect(getEntityByUID(world, scene, 'alice')).toBe(e)
    destroyWorld(world)
  })
})
