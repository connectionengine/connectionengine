/**
 * Compression helpers for Vec3 + quaternion fields on the runtime wire.
 *
 * Two schemes:
 *
 *   - **Vec3 → 3 × int16**: each axis quantised to a signed 16-bit integer
 *     spanning [-range, +range]. 6 bytes per Vec3 vs 12 raw. Good for
 *     positions/velocities with known bounds.
 *
 *   - **Quaternion → smallest-three (32 bits total)**: store the index of the
 *     largest component (2 bits) and the three smaller components as 10-bit
 *     signed integers in the range [-√½, +√½] (the largest is reconstructed
 *     from the unit constraint). 4 bytes per quaternion vs 16 raw.
 *
 * Both encodings are opt-in per component via `createBinaryPipeline`'s
 * `compression` option, e.g.
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
 * Anything not in the `compression` map encodes raw, preserving full Float32.
 */

import { readInt16, readUint32, writeInt16, writeUint32, type ViewCursor } from './cursor'

// ── Vec3 ↔ 3 × int16 ─────────────────────────────────────────────────────────-

export interface Vec3Int16Spec {
  kind: 'vec3-int16'
  /** Half-range of each axis. Encoded value clamps to [-range, +range]. */
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

/** 6 bytes per Vec3 (3 × int16). */
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
 * Encode a unit quaternion as 32 bits: [2-bit largest-component index][3 × 10-bit signed components].
 *
 * The largest absolute-value component is dropped (reconstructed from unit
 * constraint). The remaining three are scaled into [-1, +1] (since the
 * dropped one's magnitude ≥ √½, the others are ≤ √½, but we scale by √½ to
 * use the full 10-bit range).
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
  // Flip sign so the largest component is positive (since we don't store its sign).
  const sign = [x, y, z, w][idx] < 0 ? -1 : 1
  const components = [x * sign, y * sign, z * sign, w * sign]
  const a = components[(idx + 1) & 3]
  const b = components[(idx + 2) & 3]
  const c = components[(idx + 3) & 3]
  // Pack: idx (2) | a (10) | b (10) | c (10) = 32 bits
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
  // Reconstruct the largest from unit constraint
  const dSquared = 1 - (a * a + b * b + c * c)
  const d = dSquared > 0 ? Math.sqrt(dSquared) : 0
  const out: [number, number, number, number] = [0, 0, 0, 0]
  out[idx] = d
  out[(idx + 1) & 3] = a
  out[(idx + 2) & 3] = b
  out[(idx + 3) & 3] = c
  return out
}

/** 4 bytes per quaternion (single packed u32). */
export const QUAT_SMALLEST3_BYTES = 4

const quantiseComponent = (v: number): number => {
  // v is in [-√½, +√½]. Scale into [-COMP_MAX, +COMP_MAX]. Pack as 10-bit two's complement.
  const scaled = Math.round((v / SQRT_HALF) * COMP_MAX)
  const clamped = scaled > COMP_MAX ? COMP_MAX : scaled < -COMP_MAX ? -COMP_MAX : scaled
  // Two's complement for 10 bits
  return clamped < 0 ? clamped + (1 << COMP_BITS) : clamped
}

const dequantiseComponent = (q: number): number => {
  // q is a 10-bit two's complement integer
  const signed = q & (1 << (COMP_BITS - 1)) ? q - (1 << COMP_BITS) : q
  return (signed / COMP_MAX) * SQRT_HALF
}

// ── Spec union + per-component map ───────────────────────────────────────────-

export type FieldCompressionSpec = Vec3Int16Spec | QuatSmallest3Spec

/** `{ [componentId]: { [fieldName]: FieldCompressionSpec } }` */
export type CompressionConfig = Record<string, Record<string, FieldCompressionSpec>>
