import { describe, expect, it } from 'vitest'
import { Schema } from '../schema'
import { createAnonAgent, createWorld, destroyWorld } from '../ecs/world'
import { createEngine } from '../ecs/engine'
import { createEntity } from '../ecs/entity'
import { defineComponent, getComponent, getInstanceStore, setComponent } from '../ecs/component'
import { createBinaryPipeline } from './binary'

const Transform = defineComponent({
  id: 'Bin.Transform',
  schema: Schema.Object({
    position: Schema.Vec3({ sync: 'continuous' }),
    rotation: Schema.Quat({ sync: 'continuous' })
  })
})

const Velocity = defineComponent({
  id: 'Bin.Velocity',
  schema: Schema.Object({
    linear: Schema.Vec3({ sync: 'continuous' })
  })
})

const soaSet = (
  component: Record<string, unknown>,
  entity: number,
  field: string,
  channel: string,
  value: number
): void => {
  const soa = component[field] as Record<string, Record<number, number>>
  soa[channel][entity] = value
}

const soaGet = (component: Record<string, unknown>, entity: number, field: string, channel: string): number => {
  const soa = component[field] as Record<string, Record<number, number>>
  return soa[channel][entity]
}

describe('createBinaryPipeline — paired write + read', () => {
  it('round-trips multiple entities + components between two worlds', () => {
    const source = createWorld({ engine: createEngine(), agent: createAnonAgent('pipe-src') })
    const target = createWorld({ engine: createEngine(), agent: createAnonAgent('pipe-tgt') })

    const sourcePipe = createBinaryPipeline(source, [Transform, Velocity])
    const targetPipe = createBinaryPipeline(target, [Transform, Velocity])

    const e1 = createEntity(source)
    const e2 = createEntity(source)
    setComponent(source, e1, Transform, { position: [1, 2, 3], rotation: [0, 0, 0, 1] })
    setComponent(source, e1, Velocity, { linear: [0.1, 0.2, 0.3] })
    setComponent(source, e2, Transform, { position: [10, 20, 30], rotation: [0, 0, 0, 1] })

    const buf = sourcePipe.write({ timestamp: 1700000000 }, [
      { networkId: 100, entity: e1 },
      { networkId: 200, entity: e2 }
    ])

    // Pre-warm target's per-world SoA stores so the codec has somewhere to write
    const t1 = createEntity(target)
    const t2 = createEntity(target)
    setComponent(target, t1, Transform, {})
    setComponent(target, t1, Velocity, {})
    setComponent(target, t2, Transform, {})

    const idMap = new Map<number, number>([
      [100, t1],
      [200, t2]
    ])
    const header = targetPipe.read(buf, (nid) => idMap.get(nid))
    expect(header.timestamp).toBeCloseTo(1700000000)
    expect(header.entityCount).toBe(2)

    expect(soaGet(Transform, t1, 'position', 'x')).toBeCloseTo(1)
    expect(soaGet(Transform, t2, 'position', 'x')).toBeCloseTo(10)
    expect(soaGet(Velocity, t1, 'linear', 'x')).toBeCloseTo(0.1)

    destroyWorld(source)
    destroyWorld(target)
  })

  it('persists shadow state across writes so unchanged entities emit zero payload', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent('pipe-shadow') })
    const pipe = createBinaryPipeline(world, [Velocity])
    const e = createEntity(world)
    setComponent(world, e, Velocity, { linear: [1, 2, 3] })

    const HEADER = 8 + 4 // timestamp + entityCount
    const buf1 = pipe.write({ timestamp: 1 }, [{ networkId: 1, entity: e }])
    expect(buf1.byteLength).toBeGreaterThan(HEADER)

    const buf2 = pipe.write({ timestamp: 2 }, [{ networkId: 1, entity: e }])
    expect(buf2.byteLength).toBe(HEADER) // no entity payload — nothing changed

    soaSet(Velocity, e, 'linear', 'x', 99)
    const buf3 = pipe.write({ timestamp: 3 }, [{ networkId: 1, entity: e }])
    expect(buf3.byteLength).toBeGreaterThan(buf2.byteLength)
    expect(buf3.byteLength).toBeLessThan(buf1.byteLength) // delta, not full
    destroyWorld(world)
  })

  it('forceFullSync re-sends all fields regardless of shadow', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent('pipe-full') })
    const pipe = createBinaryPipeline(world, [Velocity])
    const e = createEntity(world)
    setComponent(world, e, Velocity, { linear: [1, 2, 3] })

    const full1 = pipe.write({ timestamp: 1 }, [{ networkId: 1, entity: e }])
    const empty = pipe.write({ timestamp: 2 }, [{ networkId: 1, entity: e }])
    const full2 = pipe.write({ timestamp: 3 }, [{ networkId: 1, entity: e }], true)
    expect(empty.byteLength).toBeLessThan(full1.byteLength)
    expect(full2.byteLength).toBe(full1.byteLength)
    destroyWorld(world)
  })

  it('resetShadow forces a full snapshot on the next write', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent('pipe-reset') })
    const pipe = createBinaryPipeline(world, [Velocity])
    const e = createEntity(world)
    setComponent(world, e, Velocity, { linear: [1, 2, 3] })

    const full = pipe.write({ timestamp: 1 }, [{ networkId: 1, entity: e }])
    pipe.write({ timestamp: 2 }, [{ networkId: 1, entity: e }]) // shadow up to date
    pipe.resetShadow()
    const afterReset = pipe.write({ timestamp: 3 }, [{ networkId: 1, entity: e }])
    expect(afterReset.byteLength).toBe(full.byteLength)
    destroyWorld(world)
  })

  it('unknown networkId on read still parses cleanly (cursor stays in sync)', () => {
    const source = createWorld({ engine: createEngine(), agent: createAnonAgent('pipe-unknown-src') })
    const target = createWorld({ engine: createEngine(), agent: createAnonAgent('pipe-unknown-tgt') })
    const sourcePipe = createBinaryPipeline(source, [Velocity])
    const targetPipe = createBinaryPipeline(target, [Velocity])
    const t = createEntity(target)
    setComponent(target, t, Velocity, {})

    const e1 = createEntity(source)
    const e2 = createEntity(source)
    setComponent(source, e1, Velocity, { linear: [1, 1, 1] })
    setComponent(source, e2, Velocity, { linear: [9, 9, 9] })

    const buf = sourcePipe.write({ timestamp: 1 }, [
      { networkId: 100, entity: e1 },
      { networkId: 200, entity: e2 }
    ])
    // The resolver knows network ID 200 (mapped to t). It does not know 100.
    const header = targetPipe.read(buf, (nid: number) => (nid === 200 ? t : undefined))
    expect(header.entityCount).toBe(2)
    expect(soaGet(Velocity, t, 'linear', 'x')).toBeCloseTo(9)
    destroyWorld(source)
    destroyWorld(target)
  })

  it('Transform with one changed field emits ~6 bytes per entity (mask + 1 float)', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent('pipe-delta-size') })
    const pipe = createBinaryPipeline(world, [Transform])
    const e = createEntity(world)
    setComponent(world, e, Transform, { position: [1, 1, 1], rotation: [0, 0, 0, 1] })

    pipe.write({ timestamp: 1 }, [{ networkId: 1, entity: e }]) // populate shadow
    soaSet(Transform, e, 'position', 'x', 99)

    const HEADER = 8 + 4 // timestamp + entityCount
    const ENTITY_PREFIX = 4 + 1 // networkId + entityMask
    const COMPONENT_BLOCK = 1 + 4 // componentMask + 1 Float32
    const buf = pipe.write({ timestamp: 2 }, [{ networkId: 1, entity: e }])
    expect(buf.byteLength).toBe(HEADER + ENTITY_PREFIX + COMPONENT_BLOCK)
    destroyWorld(world)
  })

  it('throws if constructed with empty components list', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent('pipe-empty') })
    expect(() => createBinaryPipeline(world, [])).toThrow(/at least one component/i)
    destroyWorld(world)
  })

  it('exposes the components list in registration order', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent('pipe-order') })
    const pipe = createBinaryPipeline(world, [Transform, Velocity])
    expect(pipe.components).toEqual([Transform, Velocity])
    destroyWorld(world)
  })
})

// ── Spec 08: per-field sync/sparse in the binary pipeline ────────────────────

const DiscreteOnly = defineComponent({
  id: 'Bin.DiscreteOnly',
  schema: Schema.Object({
    position: Schema.Vec3(),
    rotation: Schema.Quat()
  })
})

const MixedContinuousDiscrete = defineComponent({
  id: 'Bin.MixedCD',
  schema: Schema.Object({
    position: Schema.Vec3({ sync: 'continuous' }),
    label: Schema.String({ default: '' })
  })
})

const SparseContinuous = defineComponent({
  id: 'Bin.SparseCont',
  schema: Schema.Object({
    offset: Schema.Vec3({ sync: 'continuous', sparse: true })
  })
})

const SparseScalarContinuous = defineComponent({
  id: 'Bin.SparseScalar',
  schema: Schema.Object({
    height: Schema.Float32({ sync: 'continuous', sparse: true })
  })
})

const MixedDenseSparse = defineComponent({
  id: 'Bin.MixedDS',
  schema: Schema.Object({
    position: Schema.Vec3({ sync: 'continuous' }),
    offset: Schema.Vec3({ sync: 'continuous', sparse: true })
  })
})

describe('Spec 08 — binary pipeline includes only continuous fields', () => {
  it('discrete-only component produces zero payload', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent('s08-disc') })
    const pipe = createBinaryPipeline(world, [DiscreteOnly])
    const e = createEntity(world)
    setComponent(world, e, DiscreteOnly, { position: [1, 2, 3], rotation: [0, 0, 0, 1] })

    const HEADER = 8 + 4
    const buf = pipe.write({ timestamp: 1 }, [{ networkId: 1, entity: e }])
    expect(buf.byteLength).toBe(HEADER)
    destroyWorld(world)
  })

  it('mixed continuous+discrete component only transports the continuous field', () => {
    const source = createWorld({ engine: createEngine(), agent: createAnonAgent('s08-mix-src') })
    const target = createWorld({ engine: createEngine(), agent: createAnonAgent('s08-mix-tgt') })
    const sPipe = createBinaryPipeline(source, [MixedContinuousDiscrete])
    const tPipe = createBinaryPipeline(target, [MixedContinuousDiscrete])

    const e = createEntity(source)
    setComponent(source, e, MixedContinuousDiscrete, { position: [5, 10, 15], label: 'hello' })

    const buf = sPipe.write({ timestamp: 1 }, [{ networkId: 1, entity: e }])

    const t = createEntity(target)
    setComponent(target, t, MixedContinuousDiscrete, { label: 'stale' })

    tPipe.read(buf, (nid) => (nid === 1 ? t : undefined))

    expect(soaGet(MixedContinuousDiscrete, t, 'position', 'x')).toBeCloseTo(5)
    expect(soaGet(MixedContinuousDiscrete, t, 'position', 'y')).toBeCloseTo(10)
    expect(soaGet(MixedContinuousDiscrete, t, 'position', 'z')).toBeCloseTo(15)

    const tVal = getComponent(target, t, MixedContinuousDiscrete)
    expect(tVal?.label).toBe('stale')

    destroyWorld(source)
    destroyWorld(target)
  })
})

describe('Spec 08 — sparse continuous fields round-trip through binary', () => {
  it('sparse Vec3 stages from instance store, writes binary, unstages on read', () => {
    const source = createWorld({ engine: createEngine(), agent: createAnonAgent('s08-sparse-src') })
    const target = createWorld({ engine: createEngine(), agent: createAnonAgent('s08-sparse-tgt') })
    const sPipe = createBinaryPipeline(source, [SparseContinuous])
    const tPipe = createBinaryPipeline(target, [SparseContinuous])

    const e = createEntity(source)
    setComponent(source, e, SparseContinuous, { offset: [3, 6, 9] })

    const buf = sPipe.write({ timestamp: 1 }, [{ networkId: 1, entity: e }])
    const HEADER = 8 + 4
    expect(buf.byteLength).toBeGreaterThan(HEADER)

    const t = createEntity(target)
    setComponent(target, t, SparseContinuous, {})

    tPipe.read(buf, (nid) => (nid === 1 ? t : undefined))

    const store = getInstanceStore(target, SparseContinuous)
    const values = store[t]?.offset as number[]
    expect(values[0]).toBeCloseTo(3)
    expect(values[1]).toBeCloseTo(6)
    expect(values[2]).toBeCloseTo(9)

    destroyWorld(source)
    destroyWorld(target)
  })

  it('sparse scalar stages and round-trips a single float', () => {
    const source = createWorld({ engine: createEngine(), agent: createAnonAgent('s08-ss-src') })
    const target = createWorld({ engine: createEngine(), agent: createAnonAgent('s08-ss-tgt') })
    const sPipe = createBinaryPipeline(source, [SparseScalarContinuous])
    const tPipe = createBinaryPipeline(target, [SparseScalarContinuous])

    const e = createEntity(source)
    setComponent(source, e, SparseScalarContinuous, { height: 42.5 })

    const buf = sPipe.write({ timestamp: 1 }, [{ networkId: 1, entity: e }])

    const t = createEntity(target)
    setComponent(target, t, SparseScalarContinuous, {})

    tPipe.read(buf, (nid) => (nid === 1 ? t : undefined))

    const store = getInstanceStore(target, SparseScalarContinuous)
    expect(store[t]?.height).toBeCloseTo(42.5)

    destroyWorld(source)
    destroyWorld(target)
  })

  it('sparse continuous field participates in shadow-map change detection', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent('s08-sparse-shadow') })
    const pipe = createBinaryPipeline(world, [SparseContinuous])
    const e = createEntity(world)
    setComponent(world, e, SparseContinuous, { offset: [1, 2, 3] })

    const HEADER = 8 + 4
    const buf1 = pipe.write({ timestamp: 1 }, [{ networkId: 1, entity: e }])
    expect(buf1.byteLength).toBeGreaterThan(HEADER)

    const buf2 = pipe.write({ timestamp: 2 }, [{ networkId: 1, entity: e }])
    expect(buf2.byteLength).toBe(HEADER)

    const store = getInstanceStore(world, SparseContinuous)
    ;(store[e]!.offset as number[])[0] = 99
    const buf3 = pipe.write({ timestamp: 3 }, [{ networkId: 1, entity: e }])
    expect(buf3.byteLength).toBeGreaterThan(HEADER)

    destroyWorld(world)
  })
})

describe('Spec 08 — mixed dense + sparse continuous fields', () => {
  it('round-trips both dense SoA and sparse instance-store fields', () => {
    const source = createWorld({ engine: createEngine(), agent: createAnonAgent('s08-ds-src') })
    const target = createWorld({ engine: createEngine(), agent: createAnonAgent('s08-ds-tgt') })
    const sPipe = createBinaryPipeline(source, [MixedDenseSparse])
    const tPipe = createBinaryPipeline(target, [MixedDenseSparse])

    const e = createEntity(source)
    setComponent(source, e, MixedDenseSparse, { position: [1, 2, 3], offset: [10, 20, 30] })

    const buf = sPipe.write({ timestamp: 1 }, [{ networkId: 1, entity: e }])

    const t = createEntity(target)
    setComponent(target, t, MixedDenseSparse, {})

    tPipe.read(buf, (nid) => (nid === 1 ? t : undefined))

    expect(soaGet(MixedDenseSparse, t, 'position', 'x')).toBeCloseTo(1)
    expect(soaGet(MixedDenseSparse, t, 'position', 'y')).toBeCloseTo(2)
    expect(soaGet(MixedDenseSparse, t, 'position', 'z')).toBeCloseTo(3)

    const store = getInstanceStore(target, MixedDenseSparse)
    const offset = store[t]?.offset as number[]
    expect(offset[0]).toBeCloseTo(10)
    expect(offset[1]).toBeCloseTo(20)
    expect(offset[2]).toBeCloseTo(30)

    destroyWorld(source)
    destroyWorld(target)
  })

  it('delta write detects changes independently in dense and sparse halves', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent('s08-ds-delta') })
    const pipe = createBinaryPipeline(world, [MixedDenseSparse])
    const e = createEntity(world)
    setComponent(world, e, MixedDenseSparse, { position: [1, 2, 3], offset: [10, 20, 30] })

    const HEADER = 8 + 4
    pipe.write({ timestamp: 1 }, [{ networkId: 1, entity: e }])

    const noChange = pipe.write({ timestamp: 2 }, [{ networkId: 1, entity: e }])
    expect(noChange.byteLength).toBe(HEADER)

    soaSet(MixedDenseSparse, e, 'position', 'x', 99)
    const denseOnly = pipe.write({ timestamp: 3 }, [{ networkId: 1, entity: e }])
    expect(denseOnly.byteLength).toBeGreaterThan(HEADER)

    const noChange2 = pipe.write({ timestamp: 4 }, [{ networkId: 1, entity: e }])
    expect(noChange2.byteLength).toBe(HEADER)

    const store = getInstanceStore(world, MixedDenseSparse)
    ;(store[e]!.offset as number[])[1] = 99
    const sparseOnly = pipe.write({ timestamp: 5 }, [{ networkId: 1, entity: e }])
    expect(sparseOnly.byteLength).toBeGreaterThan(HEADER)

    destroyWorld(world)
  })
})
