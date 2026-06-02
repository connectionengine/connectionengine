/**
 * Unified `Schema` namespace.
 *
 * Single recursive schema authoring surface: value-typed primitives map directly
 * to TypeBox; SoA-typed values (Vec3, Quat, Float32, ...) carry the SoAStore kind
 * tag. `defineComponent` walks the schema, materialises SoA stores for tagged
 * fields and an instance store for the rest, and derives mutation category from
 * field-type composition when not explicitly set.
 *
 * Usage:
 *   Schema.Object({
 *     position: Schema.Vec3(),
 *     rotation: Schema.Quat(),
 *     visible:  Schema.Boolean({ default: true }),
 *   })
 */

import { Type } from '@sinclair/typebox'
import { SoA } from './soa'

export const Schema = {
  // Value-typed (TypeBox-native — instance store + authored transport)
  String: Type.String.bind(Type),
  Number: Type.Number.bind(Type),
  Boolean: Type.Boolean.bind(Type),
  Integer: Type.Integer.bind(Type),
  Object: Type.Object.bind(Type),
  Array: Type.Array.bind(Type),
  Record: Type.Record.bind(Type),
  Union: Type.Union.bind(Type),
  Literal: Type.Literal.bind(Type),
  Optional: Type.Optional.bind(Type),
  Null: Type.Null.bind(Type),
  Any: Type.Any.bind(Type),
  Unknown: Type.Unknown.bind(Type),
  Enum: Type.Enum.bind(Type),

  // SoA-typed (typed arrays — runtime transport by default)
  Uint8: SoA.Uint8,
  Int8: SoA.Int8,
  Uint16: SoA.Uint16,
  Int16: SoA.Int16,
  Uint32: SoA.Uint32,
  Int32: SoA.Int32,
  Float32: SoA.Float32,
  Float64: SoA.Float64,
  Vec2: SoA.Vec2,
  Vec3: SoA.Vec3,
  Vec4: SoA.Vec4,
  Quat: SoA.Quat,
  Quat2: SoA.Quat2,
  Mat2: SoA.Mat2,
  Mat3: SoA.Mat3,
  Mat4: SoA.Mat4
} as const

export type { Static, TSchema, TObject } from '@sinclair/typebox'
export { Kind } from '@sinclair/typebox'
export type { ArrayBufferKind, SoAStoreKind } from './kinds'
