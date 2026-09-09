import { Type, Kind } from '@sinclair/typebox'
import type { SoAStoreKind, ArrayBufferKind } from './kinds'
import { Vec2, Vec2SoA } from '../maths/vec2'
import { Vec3, Vec3SoA } from '../maths/vec3'
import { Vec4, Vec4SoA } from '../maths/vec4'
import { Quat, QuatSoA } from '../maths/quat'
import { Quat2, Quat2SoA } from '../maths/quat2'
import { TypedArrayConstructor } from '../maths/common'

export const createSoASchema =
  <T extends TypedArrayConstructor>(type: T) =>
  () =>
    Type.Unsafe<ArrayBufferKind<InstanceType<T>>>({
      [Kind]: 'ArrayBuffer',
      type: '',
      instanceOf: type
    }) as ArrayBufferKind<InstanceType<T>>

export const createSoAMathSchema =
  <T extends TypedArrayConstructor, S, C>(construct: new (type: T) => C, defaultType: T) =>
  (type?: T) =>
    Type.Unsafe<SoAStoreKind<T, S, C>>({
      [Kind]: 'SoAStore',
      type: 'object',
      instanceOf: type ?? defaultType,
      construct: construct
    }) as unknown as SoAStoreKind<T, S, C>

export const SoA = {
  // Primitives
  Uint8: createSoASchema(Uint8Array),
  Int8: createSoASchema(Int8Array),
  Uint16: createSoASchema(Uint16Array),
  Int16: createSoASchema(Int16Array),
  Uint32: createSoASchema(Uint32Array),
  Int32: createSoASchema(Int32Array),
  Float32: createSoASchema(Float32Array),
  Float64: createSoASchema(Float64Array),

  // Vectors
  Vec2: createSoAMathSchema<TypedArrayConstructor, Vec2, Vec2SoA<any>>(Vec2SoA, Float32Array),
  Vec3: createSoAMathSchema<TypedArrayConstructor, Vec3, Vec3SoA<any>>(Vec3SoA, Float32Array),
  Vec4: createSoAMathSchema<TypedArrayConstructor, Vec4, Vec4SoA<any>>(Vec4SoA, Float32Array),

  // Quaternions
  Quat: createSoAMathSchema<TypedArrayConstructor, Quat, QuatSoA<any>>(QuatSoA, Float32Array),
  Quat2: createSoAMathSchema<TypedArrayConstructor, Quat2, Quat2SoA<any>>(Quat2SoA, Float32Array),

  // Matrices (Standard Float32Array, not SoA proxied)
  Mat2: () => Type.Unsafe<Float32Array>({ type: 'object', instanceOf: Float32Array, default: new Float32Array(4) }),
  Mat2d: () => Type.Unsafe<Float32Array>({ type: 'object', instanceOf: Float32Array, default: new Float32Array(6) }),
  Mat3: () => Type.Unsafe<Float32Array>({ type: 'object', instanceOf: Float32Array, default: new Float32Array(9) }),
  Mat4: () => Type.Unsafe<Float32Array>({ type: 'object', instanceOf: Float32Array, default: new Float32Array(16) })
}
