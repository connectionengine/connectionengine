/**
 * Unified `Schema` namespace.
 *
 * One recursive surface for schema authoring. A value-typed primitive maps
 * directly to TypeBox. An SoA-typed value (Vec3, Quat, Float32, ...) carries
 * the SoAStore kind tag and accepts per-field `sync` and `sparse` options.
 *
 * `defineComponent` walks the schema. For each SoA-tagged field it reads
 * `sparse` to decide storage (SoA typed arrays vs instance store) and `sync`
 * to decide transport (continuous binary delta vs discrete authored event).
 *
 * Defaults: `sync: 'discrete'`, `sparse: false`.
 *
 * Usage:
 *   Schema.Object({
 *     position: Schema.Vec3({ sync: 'continuous' }),
 *     rotation: Schema.Quat({ sync: 'continuous' }),
 *     visible:  Schema.Boolean({ default: true }),
 *     spawnPos: Schema.Vec3({ sparse: true }),
 *   })
 */

import { Type } from '@sinclair/typebox'
import { SoA } from './soa'

export const Schema = {
  // Value-typed. These are TypeBox-native, and use the instance store and the
  // authored transport.
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

  // SoA-typed. Accept per-field { sync, sparse } options. Default: discrete + dense.
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
