import { describe, expect, it } from 'vitest'
import { Schema } from '../schema'
import { createEngine } from './engine'
import { createAnonAgent, createWorld, destroyWorld } from './world'
import { createEntity } from './entity'
import {
  defineComponent,
  drainRuntimeDirty,
  getComponent,
  hasComponent,
  hasSyncedSoA,
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

/**
 * Mixed-channel component — a governed discrete half (`label`) alongside an
 * ungoverned continuous half (`position`). Existence and the discrete fields
 * ship as authored events; the SoA fields ship as binary deltas.
 */
const Mixed = defineComponent({
  id: 'Mixed',
  schema: Schema.Object({
    position: Schema.Vec3(),
    label: Schema.String({ default: '' })
  })
})

const Debug = defineComponent({
  id: 'Debug',
  sync: false,
  schema: Schema.Object({
    label: Schema.String({ default: '' })
  })
})

describe('defineComponent — replication contract', () => {
  it('hasSyncedSoA marks exactly the components with continuous state', () => {
    expect(hasSyncedSoA(Health)).toBe(false) // value fields only
    expect(hasSyncedSoA(Transform)).toBe(true) // SoA only
    expect(hasSyncedSoA(Mixed)).toBe(true) // both halves
    expect(hasSyncedSoA(Debug)).toBe(false) // sync: false — never replicates
  })

  it('a SoA-bearing schema is still opted out by `sync: false`', () => {
    const LocalPose = defineComponent({
      id: 'LocalPose',
      sync: false,
      schema: Schema.Object({ position: Schema.Vec3() })
    })
    expect(LocalPose.$soaFields).toEqual(['position'])
    expect(hasSyncedSoA(LocalPose)).toBe(false)
  })

  it('partitions fields by storage kind', () => {
    expect(Mixed.$soaFields).toEqual(['position'])
    expect(Mixed.$valueFields).toEqual(['label'])
  })

  it('generates ComponentSchema metadata', () => {
    expect(Health.$componentSchema.id).toBe('Health')
    expect(Health.$componentSchema.jsonSchema).toBeDefined()
    expect(Health.$componentSchema.shaclShape).toBeDefined()
  })
})

describe('setComponent / getComponent / removeComponent', () => {
  it('round-trips value-typed fields with defaults', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const e = createEntity(world)
    setComponent(world, e, Health)
    const h = getComponent(world, e, Health)
    expect(h).toEqual({ current: 100, max: 100 })
    destroyWorld(world)
  })

  it('partial set merges into existing instance', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const e = createEntity(world)
    setComponent(world, e, Health, { current: 50 })
    expect(getComponent(world, e, Health)).toEqual({ current: 50, max: 100 })
    setComponent(world, e, Health, { max: 200 })
    expect(getComponent(world, e, Health)).toEqual({ current: 50, max: 200 })
    destroyWorld(world)
  })

  it('writes and reads SoA fields via Vec3/Quat helpers', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const e = createEntity(world)
    setComponent(world, e, Transform, { position: [1, 2, 3], rotation: [0, 0, 0, 1] })
    const t = getComponent(world, e, Transform)
    expect(t?.position.x).toBeCloseTo(1)
    expect(t?.position.y).toBeCloseTo(2)
    expect(t?.position.z).toBeCloseTo(3)
    expect(t?.rotation.w).toBeCloseTo(1)
    // SoA arrays live directly on the definition for the bitECS-style hot path.
    expect(Transform.position.x[e]).toBeCloseTo(1)
    expect(Transform.position.y[e]).toBeCloseTo(2)
    expect(Transform.position.z[e]).toBeCloseTo(3)
    expect(Transform.rotation.w[e]).toBeCloseTo(1)
    destroyWorld(world)
  })

  it('getComponent returns a stable object reference across calls', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const e = createEntity(world)
    // Event component — instance store is the live data
    setComponent(world, e, Health, { current: 50 })
    const h1 = getComponent(world, e, Health)
    const h2 = getComponent(world, e, Health)
    expect(h1).toBe(h2)
    // Continuous component — cached view bag, same reference + same per-field views
    setComponent(world, e, Transform, { position: [1, 2, 3], rotation: [0, 0, 0, 1] })
    const t1 = getComponent(world, e, Transform)
    const t2 = getComponent(world, e, Transform)
    expect(t1).toBe(t2)
    expect(t1?.position).toBe(t2?.position) // SoA view reused per entity
    expect(t1?.rotation).toBe(t2?.rotation)
    // Values reflect the latest setComponent on each call without any refresh.
    setComponent(world, e, Transform, { position: [9, 9, 9] })
    const t3 = getComponent(world, e, Transform)
    expect(t3).toBe(t1)
    expect(t3?.position.x).toBeCloseTo(9)
    destroyWorld(world)
  })

  it('hasComponent toggles correctly across set/remove', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const e = createEntity(world)
    expect(hasComponent(world, e, Health)).toBe(false)
    setComponent(world, e, Health)
    expect(hasComponent(world, e, Health)).toBe(true)
    removeComponent(world, e, Health)
    expect(hasComponent(world, e, Health)).toBe(false)
    expect(getComponent(world, e, Health)).toBeUndefined()
    destroyWorld(world)
  })

  it('attaches a ComponentSchema to the definition at definition time', () => {
    expect(Health.$componentSchema).toBeDefined()
    expect(Health.$componentSchema.id).toBe('Health')
    expect(Health.$componentSchema.shaclShape).toBeDefined()
  })

  it('origin: network skips the authored queue (suppresses re-broadcast)', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const e = createEntity(world)
    setComponent(world, e, Health, { current: 80 })
    expect(world.authoredQueue).toHaveLength(1)
    setComponent(world, e, Health, { current: 70 }, { origin: 'network' })
    expect(world.authoredQueue).toHaveLength(1)
    destroyWorld(world)
  })
})

describe('mixed-channel components', () => {
  /**
   * The contract: existence is governed, values are governed only where they
   * are discrete. Creation and discrete writes author events; continuous
   * writes only mark dirty.
   */
  const mk = () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    return { world, e: createEntity(world) }
  }

  it('getComponent returns one merged live view over both halves', () => {
    const { world, e } = mk()
    setComponent(world, e, Mixed, { position: [1, 2, 3], label: 'rock' })
    const m = getComponent(world, e, Mixed)
    expect(m?.label).toBe('rock')
    expect(m?.position.x).toBeCloseTo(1)
    expect(m?.position.z).toBeCloseTo(3)
    destroyWorld(world)
  })

  it('the merged view is stable and live on both halves', () => {
    const { world, e } = mk()
    setComponent(world, e, Mixed, { position: [1, 2, 3], label: 'a' })
    const first = getComponent(world, e, Mixed)
    expect(getComponent(world, e, Mixed)).toBe(first)
    setComponent(world, e, Mixed, { position: [9, 9, 9], label: 'b' })
    expect(first?.position.x).toBeCloseTo(9)
    expect(first?.label).toBe('b')
    // SoA writes straight to the store are visible without any refresh.
    Mixed.position.x[e] = 42
    expect(first?.position.x).toBeCloseTo(42)
    destroyWorld(world)
  })

  it('the merged view survives a remove + re-add cycle', () => {
    const { world, e } = mk()
    setComponent(world, e, Mixed, { position: [1, 1, 1], label: 'before' })
    const held = getComponent(world, e, Mixed)
    removeComponent(world, e, Mixed)
    setComponent(world, e, Mixed, { position: [2, 2, 2], label: 'after' })
    // A view captured before the cycle must not be left writing into an
    // orphaned instance object.
    expect(getComponent(world, e, Mixed)?.label).toBe('after')
    expect(held?.label).toBe('after')
    destroyWorld(world)
  })

  it('writes through the merged view reach the value store', () => {
    const { world, e } = mk()
    setComponent(world, e, Mixed, { position: [0, 0, 0], label: 'x' })
    const m = getComponent(world, e, Mixed)!
    m.label = 'y'
    expect(getComponent(world, e, Mixed)?.label).toBe('y')
    destroyWorld(world)
  })

  it('instantiation authors one event carrying the WHOLE component', () => {
    const { world, e } = mk()
    setComponent(world, e, Mixed, { position: [1, 2, 3], label: 'rock' })
    expect(world.authoredQueue).toHaveLength(1)
    const queued = world.authoredQueue[0]
    expect(queued.op).toBe('set')
    // Wire-safe: SoA fields as plain arrays, value fields verbatim.
    expect(queued.value).toEqual({ position: [1, 2, 3], label: 'rock' })
    // And the continuous half is marked for the binary channel too.
    expect(world.runtimeDirty.get('Mixed')?.has(e)).toBe(true)
    destroyWorld(world)
  })

  it('a continuous-only write on an existing component authors nothing', () => {
    const { world, e } = mk()
    setComponent(world, e, Mixed, { position: [0, 0, 0], label: 'rock' })
    drainRuntimeDirty(world)
    world.authoredQueue.length = 0

    setComponent(world, e, Mixed, { position: [5, 5, 5] })
    expect(world.authoredQueue).toHaveLength(0)
    expect(world.runtimeDirty.get('Mixed')?.has(e)).toBe(true)
    destroyWorld(world)
  })

  it('a discrete write on an existing component authors the whole component', () => {
    const { world, e } = mk()
    setComponent(world, e, Mixed, { position: [1, 2, 3], label: 'rock' })
    world.authoredQueue.length = 0

    setComponent(world, e, Mixed, { label: 'boulder' })
    expect(world.authoredQueue).toHaveLength(1)
    expect(world.authoredQueue[0].value).toEqual({ position: [1, 2, 3], label: 'boulder' })
    destroyWorld(world)
  })

  it('removal authors a single event that takes both halves', () => {
    const { world, e } = mk()
    setComponent(world, e, Mixed, { position: [1, 2, 3], label: 'rock' })
    world.authoredQueue.length = 0

    removeComponent(world, e, Mixed)
    expect(world.authoredQueue).toHaveLength(1)
    expect(world.authoredQueue[0].op).toBe('remove')
    expect(hasComponent(world, e, Mixed)).toBe(false)
    expect(world.runtimeDirty.get('Mixed')?.has(e)).toBe(false)
    destroyWorld(world)
  })

  it('origin: network never authors, on either half', () => {
    const { world, e } = mk()
    setComponent(world, e, Mixed, { position: [1, 2, 3], label: 'rock' }, { origin: 'network' })
    expect(world.authoredQueue).toHaveLength(0)
    removeComponent(world, e, Mixed, { origin: 'network' })
    expect(world.authoredQueue).toHaveLength(0)
    destroyWorld(world)
  })

  it('a no-op write to an existing component authors nothing, mixed or not', () => {
    const { world, e } = mk()
    setComponent(world, e, Health, { current: 50 })
    setComponent(world, e, Mixed, { position: [0, 0, 0], label: 'rock' })
    world.authoredQueue.length = 0

    // Neither write names a discrete field, so neither is causally meaningful.
    setComponent(world, e, Health)
    setComponent(world, e, Mixed, { position: [1, 1, 1] })
    expect(world.authoredQueue).toHaveLength(0)
    destroyWorld(world)
  })

  it('a pure-continuous component authors its existence, never its motion', () => {
    const { world, e } = mk()
    // Coming into being is causal, so it authors — carrying the initial pose.
    setComponent(world, e, Transform, { position: [1, 2, 3] })
    expect(world.authoredQueue).toHaveLength(1)
    expect(world.authoredQueue[0].value).toMatchObject({ position: [1, 2, 3] })
    world.authoredQueue.length = 0

    // Moving is not. This is the write that happens every tick.
    setComponent(world, e, Transform, { position: [4, 5, 6] })
    expect(world.authoredQueue).toHaveLength(0)
    expect(world.runtimeDirty.get('Transform')?.has(e)).toBe(true)

    // Ceasing to exist is causal again.
    removeComponent(world, e, Transform)
    expect(world.authoredQueue).toHaveLength(1)
    expect(world.authoredQueue[0].op).toBe('remove')
    destroyWorld(world)
  })
})

describe('runtime dirty tracking', () => {
  it('marks dirty on runtime-category set, drains atomically', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
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
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const e = createEntity(world)
    setComponent(world, e, Health)
    setComponent(world, e, Debug, { label: 'x' })
    expect(world.runtimeDirty.size).toBe(0)
    destroyWorld(world)
  })

  it('clears dirty flag when component removed', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
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
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    for (let i = 0; i < 50; i++) {
      const e = createEntity(world)
      const cur = Math.floor(Math.random() * 1000)
      setComponent(world, e, Health, { current: cur })
      expect(getComponent(world, e, Health)?.current).toBe(cur)
    }
    destroyWorld(world)
  })

  it('idempotent registration: defining same id twice yields the same definition', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    setComponent(world, createEntity(world), Health)
    setComponent(world, createEntity(world), Health)
    const Health2 = defineComponent({
      id: 'Health',
      schema: Schema.Object({ current: Schema.Number({ default: 100 }), max: Schema.Number({ default: 100 }) })
    })
    expect(Health2).toBe(Health)
    destroyWorld(world)
  })
})
