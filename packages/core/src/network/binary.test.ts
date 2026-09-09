import { describe, expect, it } from 'vitest'
import { Schema } from '../schema'
import { createAnonAgent, createWorld, destroyWorld } from '../ecs/world'
import { createEngine } from '../ecs/engine'
import { createEntity } from '../ecs/entity'
import { defineComponent, setComponent } from '../ecs/component'
import { createBinaryPipeline } from './binary'

const Transform = defineComponent({
  id: 'Bin.Transform',
  schema: Schema.Object({
    position: Schema.Vec3(),
    rotation: Schema.Quat()
  })
})

const Velocity = defineComponent({
  id: 'Bin.Velocity',
  schema: Schema.Object({
    linear: Schema.Vec3()
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
