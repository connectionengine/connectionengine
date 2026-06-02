import { describe, expect, it } from 'vitest'
import { Schema } from './schema'
import { defineComponent, getComponent, hasComponent, setComponent } from './component'
import { defineRelation, addRelation, getRelationTargets } from './relation'
import { createWorld, destroyWorld } from './world'
import { createNamedEntity, getEntityByUID, setUID } from './identity'
import { createEntity } from './entity'
import { applySnapshot, createSnapshot } from './snapshot'

const Health = defineComponent({
  id: 'Health-snap',
  schema: Schema.Object({ current: Schema.Number({ default: 100 }), max: Schema.Number({ default: 100 }) })
})
const Transform = defineComponent({
  id: 'Transform-snap',
  schema: Schema.Object({ position: Schema.Vec3() })
})
const ChildOf = defineRelation({ name: 'ChildOf-snap', exclusive: true })

describe('Snapshot', () => {
  it('createSnapshot captures named entities + components + relations', () => {
    const world = createWorld()
    const scene = createNamedEntity(world, 'scene:snap')
    const a = createEntity(world)
    setUID(world, a, 'a', { parent: scene })
    setComponent(world, a, Health, { current: 75 })
    setComponent(world, a, Transform, { position: [1, 2, 3] })
    const b = createEntity(world)
    setUID(world, b, 'b', { parent: scene })
    addRelation(world, b, ChildOf, a)

    const snap = createSnapshot(world)
    expect(snap.metadata.entityCount).toBe(3) // scene + a + b
    expect(snap.metadata.components).toContain('Health-snap')
    expect(snap.entities.find((e) => e.path.join('/') === 'scene:snap/a')?.components['Health-snap']).toEqual({
      current: 75,
      max: 100
    })
    const bEnt = snap.entities.find((e) => e.path.join('/') === 'scene:snap/b')
    expect(bEnt?.relations['ChildOf-snap']).toEqual([['scene:snap', 'a']])
    destroyWorld(world)
  })

  it('applySnapshot to fresh world rebuilds equivalent state', () => {
    const source = createWorld()
    const scene = createNamedEntity(source, 'scene:snap2')
    const a = createEntity(source)
    setUID(source, a, 'a', { parent: scene })
    setComponent(source, a, Health, { current: 42 })
    setComponent(source, a, Transform, { position: [5, 6, 7] })

    const snap = createSnapshot(source)

    const target = createWorld()
    applySnapshot(target, snap)

    const tScene = getEntityByUID(target, 0, 'scene:snap2')
    expect(tScene).toBeDefined()
    const tA = getEntityByUID(target, tScene!, 'a')
    expect(tA).toBeDefined()
    expect(getComponent(target, tA!, Health)).toEqual({ current: 42, max: 100 })
    const tT = getComponent(target, tA!, Transform)
    expect(tT?.position[0]).toBeCloseTo(5)
    expect(tT?.position[1]).toBeCloseTo(6)
    expect(tT?.position[2]).toBeCloseTo(7)
    destroyWorld(source)
    destroyWorld(target)
  })

  it('snapshot round-trip preserves relations', () => {
    const source = createWorld()
    const scene = createNamedEntity(source, 'scene:rel')
    const a = createEntity(source)
    setUID(source, a, 'a', { parent: scene })
    const b = createEntity(source)
    setUID(source, b, 'b', { parent: scene })
    addRelation(source, b, ChildOf, a)
    const snap = createSnapshot(source)
    const target = createWorld()
    applySnapshot(target, snap)
    const tScene = getEntityByUID(target, 0, 'scene:rel')!
    const tA = getEntityByUID(target, tScene, 'a')!
    const tB = getEntityByUID(target, tScene, 'b')!
    expect(getRelationTargets(target, tB, ChildOf)).toEqual([tA])
    destroyWorld(source)
    destroyWorld(target)
  })

  it('filter restricts captured components', () => {
    const world = createWorld()
    const e = createNamedEntity(world, 'x')
    setComponent(world, e, Health)
    setComponent(world, e, Transform, { position: [0, 0, 0] })
    const snap = createSnapshot(world, { filter: ['Health-snap'] })
    expect(snap.entities[0].components).toHaveProperty('Health-snap')
    expect(snap.entities[0].components).not.toHaveProperty('Transform-snap')
    destroyWorld(world)
  })

  it('replace mode clears prior named entities', () => {
    const world = createWorld()
    const a = createNamedEntity(world, 'a')
    setComponent(world, a, Health, { current: 1 })
    const snap = createSnapshot(world)
    setComponent(world, a, Health, { current: 999 })
    expect(getComponent(world, a, Health)).toEqual({ current: 999, max: 100 })
    applySnapshot(world, snap, { replace: true })
    const restored = getEntityByUID(world, 0, 'a')!
    expect(hasComponent(world, restored, Health)).toBe(true)
    expect(getComponent(world, restored, Health)).toEqual({ current: 1, max: 100 })
    destroyWorld(world)
  })
})
