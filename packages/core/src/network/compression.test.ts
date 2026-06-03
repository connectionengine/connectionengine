import { describe, expect, it } from 'vitest'
import { createViewCursor } from './cursor'
import {
  decodeQuatSmallest3,
  decodeVec3Int16,
  encodeQuatSmallest3,
  encodeVec3Int16,
  QUAT_SMALLEST3_BYTES,
  VEC3_INT16_BYTES
} from './compression'
import { Schema } from '../schema'
import { createAnonAgent, createWorld, destroyWorld } from '../ecs/world'
import { createEntity } from '../ecs/entity'
import { defineComponent, setComponent } from '../ecs/component'
import { createBinaryPipeline } from './binary'

describe('compression — vec3-int16', () => {
  it('round-trips Vec3 within range with sub-percent error', () => {
    const view = createViewCursor(new ArrayBuffer(16))
    encodeVec3Int16(view, 1.5, -2.25, 3.125, 100)
    view.cursor = 0
    const [x, y, z] = decodeVec3Int16(view, 100)
    expect(x).toBeCloseTo(1.5, 2)
    expect(y).toBeCloseTo(-2.25, 2)
    expect(z).toBeCloseTo(3.125, 2)
  })

  it('clamps values outside [-range, +range]', () => {
    const view = createViewCursor(new ArrayBuffer(16))
    encodeVec3Int16(view, 500, -500, 0, 100)
    view.cursor = 0
    const [x, y] = decodeVec3Int16(view, 100)
    expect(x).toBeCloseTo(100, 0)
    expect(y).toBeCloseTo(-100, 0)
  })

  it('uses 6 bytes per encode (3 × int16)', () => {
    const view = createViewCursor(new ArrayBuffer(16))
    encodeVec3Int16(view, 0, 0, 0, 1)
    expect(view.cursor).toBe(VEC3_INT16_BYTES)
  })
})

describe('compression — quat-smallest3', () => {
  it('round-trips identity quaternion', () => {
    const view = createViewCursor(new ArrayBuffer(8))
    encodeQuatSmallest3(view, 0, 0, 0, 1)
    view.cursor = 0
    const [x, y, z, w] = decodeQuatSmallest3(view)
    expect(x).toBeCloseTo(0, 2)
    expect(y).toBeCloseTo(0, 2)
    expect(z).toBeCloseTo(0, 2)
    expect(w).toBeCloseTo(1, 2)
  })

  it('round-trips a generic unit quaternion within ~0.005 absolute error', () => {
    // 45° around Z = (0, 0, sin(22.5°), cos(22.5°)) ≈ (0, 0, 0.3827, 0.9239)
    const view = createViewCursor(new ArrayBuffer(8))
    encodeQuatSmallest3(view, 0, 0, 0.3827, 0.9239)
    view.cursor = 0
    const [x, y, z, w] = decodeQuatSmallest3(view)
    expect(x).toBeCloseTo(0, 2)
    expect(y).toBeCloseTo(0, 2)
    expect(z).toBeCloseTo(0.3827, 2)
    expect(w).toBeCloseTo(0.9239, 2)
  })

  it('uses 4 bytes per encode (packed u32)', () => {
    const view = createViewCursor(new ArrayBuffer(8))
    encodeQuatSmallest3(view, 0, 0, 0, 1)
    expect(view.cursor).toBe(QUAT_SMALLEST3_BYTES)
  })
})

describe('createBinaryPipeline — compression integration', () => {
  it('Transform with compressed position + rotation shrinks payload', () => {
    const Transform = defineComponent({
      id: 'Cmp.Transform',
      schema: Schema.Object({ position: Schema.Vec3(), rotation: Schema.Quat() })
    })
    const world = createWorld({ agent: createAnonAgent('cmp') })
    const e = createEntity(world)
    setComponent(world, e, Transform, { position: [10, 20, 30], rotation: [0, 0, 0, 1] })

    const raw = createBinaryPipeline(world, [Transform])
    const compressed = createBinaryPipeline(world, [Transform], {
      compression: {
        'Cmp.Transform': {
          position: { kind: 'vec3-int16', range: 1000 },
          rotation: { kind: 'quat-smallest3' }
        }
      }
    })

    const rawBuf = raw.write({ fromPeerIndex: 0, timestamp: 0 }, [{ networkId: 1, entity: e }])
    const cmpBuf = compressed.write({ fromPeerIndex: 0, timestamp: 0 }, [{ networkId: 1, entity: e }])

    // Raw: 3+4 floats = 28 bytes. Compressed: 6 + 4 = 10 bytes. Both have same overhead.
    expect(cmpBuf.byteLength).toBeLessThan(rawBuf.byteLength)
    destroyWorld(world)
  })

  it('round-trips compressed Transform between two worlds within quantisation error', async () => {
    const { getComponent } = await import('../ecs/component')
    const Transform = defineComponent({
      id: 'Cmp.Round',
      schema: Schema.Object({ position: Schema.Vec3(), rotation: Schema.Quat() })
    })
    const source = createWorld({ agent: createAnonAgent('cmp-src') })
    const target = createWorld({ agent: createAnonAgent('cmp-tgt') })
    const compression = {
      'Cmp.Round': {
        position: { kind: 'vec3-int16' as const, range: 100 },
        rotation: { kind: 'quat-smallest3' as const }
      }
    }
    const sourcePipe = createBinaryPipeline(source, [Transform], { compression })
    const targetPipe = createBinaryPipeline(target, [Transform], { compression })

    const e = createEntity(source)
    setComponent(source, e, Transform, { position: [5.5, -10.25, 42], rotation: [0, 0, 0.3827, 0.9239] })

    const t = createEntity(target)
    setComponent(target, t, Transform, {})

    const buf = sourcePipe.write({ fromPeerIndex: 0, timestamp: 0 }, [{ networkId: 1, entity: e }])
    targetPipe.read(buf, () => t)

    const got = getComponent(target, t, Transform)
    expect(got?.position[0]).toBeCloseTo(5.5, 1)
    expect(got?.position[1]).toBeCloseTo(-10.25, 1)
    expect(got?.position[2]).toBeCloseTo(42, 1)
    expect(got?.rotation[2]).toBeCloseTo(0.3827, 2)
    expect(got?.rotation[3]).toBeCloseTo(0.9239, 2)
    destroyWorld(source)
    destroyWorld(target)
  })
})
