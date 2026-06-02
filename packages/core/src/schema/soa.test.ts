import { describe, it, expect } from 'vitest'
import { SoA } from './soa'
import { Kind } from '@sinclair/typebox'

describe('SoA Schemas', () => {
  it('creates Uint8 schema', () => {
    const schema = SoA.Uint8()
    expect(schema[Kind]).toBe('ArrayBuffer')
    expect(schema.instanceOf).toBe(Uint8Array)
  })

  it('creates Float32 schema', () => {
    const schema = SoA.Float32()
    expect(schema[Kind]).toBe('ArrayBuffer')
    expect(schema.instanceOf).toBe(Float32Array)
  })

  it('creates Vec3 schema', () => {
    const schema = SoA.Vec3()
    expect(schema[Kind]).toBe('SoAStore')
    // @ts-ignore
    expect(schema.instanceOf).toBe(Float32Array)
    expect(schema.construct).toBeDefined()
  })

  it('creates Quat schema', () => {
    const schema = SoA.Quat()
    expect(schema[Kind]).toBe('SoAStore')
    // @ts-ignore
    expect(schema.instanceOf).toBe(Float32Array)
  })

  it('creates Mat4 schema', () => {
    const schema = SoA.Mat4()
    expect(schema.type).toBe('object')
    // @ts-ignore
    expect(schema.instanceOf).toBe(Float32Array)
    expect(schema.default).toBeInstanceOf(Float32Array)
    expect(schema.default?.length).toBe(16)
  })
})
