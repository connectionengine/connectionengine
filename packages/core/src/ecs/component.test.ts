import { describe, expect, it } from 'vitest'
import { Schema } from '../schema'
import { createAnonAgent, createWorld, destroyWorld } from './world'
import { createEntity } from './entity'
import {
  defineComponent,
  drainRuntimeDirty,
  getComponent,
  hasComponent,
  removeComponent,
  setComponent
} from './component'

const Health = defineComponent({
  id: 'Health',
  schema: Schema.Object({
    current: Schema.Number({ default: 100 }),
    max: Schema.Number({ default: 100 })
  })
})

const Transform = defineComponent({
  id: 'Transform',
  schema: Schema.Object({
    position: Schema.Vec3(),
    rotation: Schema.Quat()
  })
})

const Debug = defineComponent({
  id: 'Debug',
  sync: false,
  schema: Schema.Object({
    label: Schema.String({ default: '' })
  })
})

describe('defineComponent — replication channel', () => {
  it('value-only schema derives to event channel', () => {
    expect(Health.channel).toBe('event')
    expect(Health.isBinary).toBe(false)
    expect(Health.sync).toBe(true)
  })

  it('SoA-bearing schema derives to continuous channel', () => {
    expect(Transform.channel).toBe('continuous')
    expect(Transform.isBinary).toBe(true)
    expect(Transform.sync).toBe(true)
  })

  it('`sync: false` opts out of replication entirely', () => {
    expect(Debug.channel).toBe('local')
    expect(Debug.sync).toBe(false)
    expect(Debug.isBinary).toBe(false)
  })

  it('mixing SoA and non-SoA fields throws', () => {
    expect(() =>
      defineComponent({
        id: 'Mixed-illegal',
        schema: Schema.Object({ position: Schema.Vec3(), label: Schema.String({ default: '' }) })
      })
    ).toThrow(/cannot mix SoA-tagged fields/i)
  })

  it('generates ComponentSchema metadata', () => {
    expect(Health.componentSchema.id).toBe('Health')
    expect(Health.componentSchema.channel).toBe('event')
    expect(Health.componentSchema.jsonSchema).toBeDefined()
    expect(Health.componentSchema.shaclShape).toBeDefined()
  })
})

describe('setComponent / getComponent / removeComponent', () => {
  it('round-trips value-typed fields with defaults', () => {
    const world = createWorld({ agent: createAnonAgent() })
    const e = createEntity(world)
    setComponent(world, e, Health)
    const h = getComponent(world, e, Health)
    expect(h).toEqual({ current: 100, max: 100 })
    destroyWorld(world)
  })

  it('partial set merges into existing instance', () => {
    const world = createWorld({ agent: createAnonAgent() })
    const e = createEntity(world)
    setComponent(world, e, Health, { current: 50 })
    expect(getComponent(world, e, Health)).toEqual({ current: 50, max: 100 })
    setComponent(world, e, Health, { max: 200 })
    expect(getComponent(world, e, Health)).toEqual({ current: 50, max: 200 })
    destroyWorld(world)
  })

  it('writes and reads SoA fields via Vec3/Quat helpers', () => {
    const world = createWorld({ agent: createAnonAgent() })
    const e = createEntity(world)
    setComponent(world, e, Transform, { position: [1, 2, 3], rotation: [0, 0, 0, 1] })
    const t = getComponent(world, e, Transform)
    expect(t?.position[0]).toBeCloseTo(1)
    expect(t?.position[1]).toBeCloseTo(2)
    expect(t?.position[2]).toBeCloseTo(3)
    expect(t?.rotation[3]).toBeCloseTo(1)
    destroyWorld(world)
  })

  it('hasComponent toggles correctly across set/remove', () => {
    const world = createWorld({ agent: createAnonAgent() })
    const e = createEntity(world)
    expect(hasComponent(world, e, Health)).toBe(false)
    setComponent(world, e, Health)
    expect(hasComponent(world, e, Health)).toBe(true)
    removeComponent(world, e, Health)
    expect(hasComponent(world, e, Health)).toBe(false)
    expect(getComponent(world, e, Health)).toBeUndefined()
    destroyWorld(world)
  })

  it('registers ComponentSchema with the world on first set', () => {
    const world = createWorld({ agent: createAnonAgent() })
    const e = createEntity(world)
    expect(world.network.schemas.has('Health')).toBe(false)
    setComponent(world, e, Health)
    expect(world.network.schemas.get('Health')).toBe(Health.componentSchema)
    destroyWorld(world)
  })

  it('emits trace events with origin tag', () => {
    const world = createWorld({ agent: createAnonAgent() })
    const e = createEntity(world)
    setComponent(world, e, Health, { current: 80 })
    const events = world.trace.byKind('component.set')
    expect(events).toHaveLength(1)
    expect(events[0].predicate).toBe('Health')
    expect(events[0].origin).toBe('local')
    expect(events[0].entity).toBe(e)
    setComponent(world, e, Health, { current: 70 }, { origin: 'network' })
    expect(world.trace.byKind('component.set')[1].origin).toBe('network')
    destroyWorld(world)
  })
})

describe('runtime dirty tracking', () => {
  it('marks dirty on runtime-category set, drains atomically', () => {
    const world = createWorld({ agent: createAnonAgent() })
    const a = createEntity(world)
    const b = createEntity(world)
    setComponent(world, a, Transform, { position: [0, 0, 0] })
    setComponent(world, b, Transform, { position: [1, 1, 1] })
    expect(world.runtimeDirty.get('Transform')?.size).toBe(2)
    const drained = drainRuntimeDirty(world)
    expect(drained.get('Transform')).toEqual(new Set([a, b]))
    expect(world.runtimeDirty.get('Transform')?.size).toBe(0)
    destroyWorld(world)
  })

  it('does not mark dirty for authored or local components', () => {
    const world = createWorld({ agent: createAnonAgent() })
    const e = createEntity(world)
    setComponent(world, e, Health)
    setComponent(world, e, Debug, { label: 'x' })
    expect(world.runtimeDirty.size).toBe(0)
    destroyWorld(world)
  })

  it('clears dirty flag when component removed', () => {
    const world = createWorld({ agent: createAnonAgent() })
    const e = createEntity(world)
    setComponent(world, e, Transform, { position: [0, 0, 0] })
    expect(world.runtimeDirty.get('Transform')?.has(e)).toBe(true)
    removeComponent(world, e, Transform)
    expect(world.runtimeDirty.get('Transform')?.has(e)).toBe(false)
    destroyWorld(world)
  })
})

describe('property invariants', () => {
  it('setComponent then getComponent round-trips a value field', () => {
    const world = createWorld({ agent: createAnonAgent() })
    for (let i = 0; i < 50; i++) {
      const e = createEntity(world)
      const cur = Math.floor(Math.random() * 1000)
      setComponent(world, e, Health, { current: cur })
      expect(getComponent(world, e, Health)?.current).toBe(cur)
    }
    destroyWorld(world)
  })

  it('idempotent registration: defining same id twice still works on the world', () => {
    const world = createWorld({ agent: createAnonAgent() })
    setComponent(world, createEntity(world), Health)
    setComponent(world, createEntity(world), Health)
    expect(world.network.schemas.size).toBe(1)
    destroyWorld(world)
  })
})
