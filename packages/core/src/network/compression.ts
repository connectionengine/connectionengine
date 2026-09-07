/**
 * Compression helpers for the Vec3 and quaternion fields on the runtime wire.
 *
 * Two schemes:
 *
 *   - **Vec3 → 3 × int16**: quantise each axis to a signed 16-bit integer that
 *     spans [-range, +range]. That gives 6 bytes per Vec3, against 12 bytes
 *     raw. Use it for a position or a velocity with known bounds.
 *
 *   - **Quaternion → smallest-three, 32 bits in total**: store the index of the
 *     largest component in 2 bits, and the three smaller components as 10-bit
 *     signed integers in the range [-√½, +√½]. The decoder reconstructs the
 *     largest component from the unit constraint. That gives 4 bytes per
 *     quaternion, against 16 bytes raw.
 *
 * You opt in to each encoding per component, through the `compression` option
 * of `createBinaryPipeline`. For example:
 *
 *   createBinaryPipeline(world, [Transform], {
 *     compression: {
 *       'Transform': {
 *         position: { kind: 'vec3-int16', range: 1000 },
 *         rotation: { kind: 'quat-smallest3' }
 *       }
 *     }
 *   })
 *
 * Every field absent from the `compression` map encodes raw, and keeps its full
 * Float32 precision.
 */

import { readInt16, readUint32, writeInt16, writeUint32, type ViewCursor } from './cursor'

// ── Vec3 ↔ 3 × int16 ─────────────────────────────────────────────────────────-

export interface Vec3Int16Spec {
  kind: 'vec3-int16'
  /** Half-range of each axis. The encoder clamps the value to [-range, +range]. */
  range: number
}

const INT16_MAX = 32767

export const encodeVec3Int16 = (view: ViewCursor, x: number, y: number, z: number, range: number): void => {
  const scale = INT16_MAX / range
  writeInt16(view, clampInt16(Math.round(x * scale)))
  writeInt16(view, clampInt16(Math.round(y * scale)))
  writeInt16(view, clampInt16(Math.round(z * scale)))
}

export const decodeVec3Int16 = (view: ViewCursor, range: number): [number, number, number] => {
  const scale = range / INT16_MAX
  return [readInt16(view) * scale, readInt16(view) * scale, readInt16(view) * scale]
}

/** 6 bytes per Vec3, as 3 × int16. */
export const VEC3_INT16_BYTES = 6

const clampInt16 = (v: number): number => (v > INT16_MAX ? INT16_MAX : v < -INT16_MAX ? -INT16_MAX : v)

// ── Quaternion → smallest-three (32 bits) ────────────────────────────────────-

export interface QuatSmallest3Spec {
  kind: 'quat-smallest3'
}

const SQRT_HALF = Math.SQRT1_2 // ≈ 0.7071
const COMP_BITS = 10
const COMP_MAX = (1 << (COMP_BITS - 1)) - 1 // 511

/**
 * Encode a unit quaternion as 32 bits: a 2-bit index of the largest component,
 * then three 10-bit signed components.
 *
 * The encoder drops the component with the largest absolute value, and the
 * decoder reconstructs it from the unit constraint. The encoder scales the
 * remaining three into [-1, +1]. The dropped component has a magnitude of at
 * least √½, so the others reach at most √½. The encoder therefore scales by √½,
 * which uses the full 10-bit range.
 */
export const encodeQuatSmallest3 = (view: ViewCursor, x: number, y: number, z: number, w: number): void => {
  let max = Math.abs(x)
  let idx = 0
  if (Math.abs(y) > max) {
    max = Math.abs(y)
    idx = 1
  }
  if (Math.abs(z) > max) {
    max = Math.abs(z)
    idx = 2
  }
  if (Math.abs(w) > max) {
    max = Math.abs(w)
    idx = 3
  }
  // Flip the sign, so that the largest component stays positive. The encoder
  // does not store the sign of that component.
  const sign = [x, y, z, w][idx] < 0 ? -1 : 1
  const components = [x * sign, y * sign, z * sign, w * sign]
  const a = components[(idx + 1) & 3]
  const b = components[(idx + 2) & 3]
  const c = components[(idx + 3) & 3]
  // Pack the fields: idx (2) | a (10) | b (10) | c (10) = 32 bits.
  const packed =
    (idx & 0b11) |
    ((quantiseComponent(a) & 0x3ff) << 2) |
    ((quantiseComponent(b) & 0x3ff) << 12) |
    ((quantiseComponent(c) & 0x3ff) << 22)
  writeUint32(view, packed)
}

export const decodeQuatSmallest3 = (view: ViewCursor): [number, number, number, number] => {
  const packed = readUint32(view)
  const idx = packed & 0b11
  const a = dequantiseComponent((packed >> 2) & 0x3ff)
  const b = dequantiseComponent((packed >> 12) & 0x3ff)
  const c = dequantiseComponent((packed >> 22) & 0x3ff)
  // Reconstruct the largest component from the unit constraint.
  const dSquared = 1 - (a * a + b * b + c * c)
  const d = dSquared > 0 ? Math.sqrt(dSquared) : 0
  const out: [number, number, number, number] = [0, 0, 0, 0]
  out[idx] = d
  out[(idx + 1) & 3] = a
  out[(idx + 2) & 3] = b
  out[(idx + 3) & 3] = c
  return out
}

/** 4 bytes per quaternion, as one packed u32. */
export const QUAT_SMALLEST3_BYTES = 4

const quantiseComponent = (v: number): number => {
  // v lies in [-√½, +√½]. Scale it into [-COMP_MAX, +COMP_MAX]. Then pack it as
  // a 10-bit two's complement value.
  const scaled = Math.round((v / SQRT_HALF) * COMP_MAX)
  const clamped = scaled > COMP_MAX ? COMP_MAX : scaled < -COMP_MAX ? -COMP_MAX : scaled
  // Apply the two's complement for 10 bits.
  return clamped < 0 ? clamped + (1 << COMP_BITS) : clamped
}

const dequantiseComponent = (q: number): number => {
  // q holds a 10-bit two's complement integer.
  const signed = q & (1 << (COMP_BITS - 1)) ? q - (1 << COMP_BITS) : q
  return (signed / COMP_MAX) * SQRT_HALF
}

// ── Spec union + per-component map ───────────────────────────────────────────-

export type FieldCompressionSpec = Vec3Int16Spec | QuatSmallest3Spec

/** The shape `{ [componentId]: { [fieldName]: FieldCompressionSpec } }`. */
export type CompressionConfig = Record<string, Record<string, FieldCompressionSpec>>
