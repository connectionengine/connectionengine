/**
 * ViewCursor — DataView with cursor position + shadow map for change tracking.
 *
 * Lifted from the EnchantmentEngine / IR Engine networking layer pattern.
 * The two critical primitives:
 *
 *   1. **`writePropIfChanged(view, typedArray, entity, ignore?)`** —
 *      compares the current `typedArray[entity]` against a per-array
 *      shadow value. Writes only if changed (with epsilon tolerance for
 *      floats). Returns whether a write happened. Callers use the return
 *      bits to build a change-mask byte that's written ONCE at the front
 *      of the component's block.
 *
 *   2. **`spaceUint8/16/32(view)`** — reserves N bytes at the current
 *      cursor and returns a deferred-write callback. Lets you write a
 *      change mask AFTER walking all props (so the mask reflects what
 *      was actually written).
 *
 * Combined, these give per-field delta encoding with zero string
 * allocation on the wire.
 */

import type { TypedArray } from '../maths/common'

// ── Type ──────────────────────────────────────────────────────────────────────

/** A DataView extended with cursor position + shadow store for diff tracking. */
export type ViewCursor = DataView & {
  cursor: number
  shadowMap: Map<TypedArray, TypedArray>
}

/** Default initial buffer for `createViewCursor`. 100 KiB is plenty for typical per-tick packets. */
export const DEFAULT_VIEW_CURSOR_BYTES = 100_000

/** Float comparison tolerance for `writePropIfChanged`. Below this, considered unchanged. */
export const PROP_EPSILON = 1e-4

// ── Construction / cursor management ─────────────────────────────────────────-

export const createViewCursor = (buffer: ArrayBuffer = new ArrayBuffer(DEFAULT_VIEW_CURSOR_BYTES)): ViewCursor => {
  const view = new DataView(buffer) as ViewCursor
  view.cursor = 0
  view.shadowMap = new Map()
  return view
}

/** Return the written-so-far slice and reset the cursor to 0 for the next packet. */
export const sliceViewCursor = (v: ViewCursor): ArrayBuffer => {
  const slice = v.buffer.slice(0, v.cursor) as ArrayBuffer
  v.cursor = 0
  return slice
}

/** Advance the cursor by `amount` bytes. */
export const scrollViewCursor = (v: ViewCursor, amount: number): ViewCursor => {
  v.cursor += amount
  return v
}

/** Set the cursor to an absolute position. */
export const moveViewCursor = (v: ViewCursor, where: number): ViewCursor => {
  v.cursor = where
  return v
}

/**
 * Capture the current cursor and return a thunk that restores it.
 * Used to undo speculative writes when a component block ends up empty
 * (no changed props → throw away the reserved change-mask space).
 */
export const rewindViewCursor = (v: ViewCursor): (() => false) => {
  const start = v.cursor
  return () => {
    v.cursor = start
    return false as const
  }
}

// ── Typed write primitives ────────────────────────────────────────────────────

export const writeUint8 = (v: ViewCursor, value: number): ViewCursor => {
  v.setUint8(v.cursor, value)
  v.cursor += 1
  return v
}
export const writeInt8 = (v: ViewCursor, value: number): ViewCursor => {
  v.setInt8(v.cursor, value)
  v.cursor += 1
  return v
}
export const writeUint16 = (v: ViewCursor, value: number): ViewCursor => {
  v.setUint16(v.cursor, value, true)
  v.cursor += 2
  return v
}
export const writeInt16 = (v: ViewCursor, value: number): ViewCursor => {
  v.setInt16(v.cursor, value, true)
  v.cursor += 2
  return v
}
export const writeUint32 = (v: ViewCursor, value: number): ViewCursor => {
  v.setUint32(v.cursor, value >>> 0, true)
  v.cursor += 4
  return v
}
export const writeFloat32 = (v: ViewCursor, value: number): ViewCursor => {
  v.setFloat32(v.cursor, value, true)
  v.cursor += 4
  return v
}
export const writeFloat64 = (v: ViewCursor, value: number): ViewCursor => {
  v.setFloat64(v.cursor, value, true)
  v.cursor += 8
  return v
}

// ── Typed read primitives ─────────────────────────────────────────────────────

export const readUint8 = (v: ViewCursor): number => {
  const x = v.getUint8(v.cursor)
  v.cursor += 1
  return x
}
export const readInt8 = (v: ViewCursor): number => {
  const x = v.getInt8(v.cursor)
  v.cursor += 1
  return x
}
export const readUint16 = (v: ViewCursor): number => {
  const x = v.getUint16(v.cursor, true)
  v.cursor += 2
  return x
}
export const readInt16 = (v: ViewCursor): number => {
  const x = v.getInt16(v.cursor, true)
  v.cursor += 2
  return x
}
export const readUint32 = (v: ViewCursor): number => {
  const x = v.getUint32(v.cursor, true)
  v.cursor += 4
  return x
}
export const readFloat32 = (v: ViewCursor): number => {
  const x = v.getFloat32(v.cursor, true)
  v.cursor += 4
  return x
}
export const readFloat64 = (v: ViewCursor): number => {
  const x = v.getFloat64(v.cursor, true)
  v.cursor += 8
  return x
}

// ── Bulk + string helpers ────────────────────────────────────────────────────-

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/** Copy `bytes` into the cursor at the current position. */
export const writeBytes = (v: ViewCursor, bytes: Uint8Array): ViewCursor => {
  new Uint8Array(v.buffer).set(bytes, v.cursor)
  v.cursor += bytes.byteLength
  return v
}

/** Read `n` bytes from the cursor as a subarray (zero-copy view onto the buffer). */
export const readBytes = (v: ViewCursor, n: number): Uint8Array => {
  const out = new Uint8Array(v.buffer, v.cursor, n)
  v.cursor += n
  return out
}

/**
 * Encode `s` as UTF-8 prefixed by its byte length as a `uint16` (length cap
 * 65535 bytes). Sufficient for entity-path segments, predicate URIs, DIDs.
 */
export const writeString = (v: ViewCursor, s: string): ViewCursor => {
  const bytes = textEncoder.encode(s)
  writeUint16(v, bytes.byteLength)
  return writeBytes(v, bytes)
}

/** Inverse of `writeString`. Copies the bytes (TextDecoder does not retain the view). */
export const readString = (v: ViewCursor): string => {
  const n = readUint16(v)
  return textDecoder.decode(readBytes(v, n))
}

/** Length-prefixed (u16) array of length-prefixed strings. */
export const writeStringArray = (v: ViewCursor, arr: readonly string[]): ViewCursor => {
  writeUint16(v, arr.length)
  for (const s of arr) writeString(v, s)
  return v
}

export const readStringArray = (v: ViewCursor): string[] => {
  const n = readUint16(v)
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(readString(v))
  return out
}

// ── Deferred-write space reservation ─────────────────────────────────────────-

/**
 * Reserve `width` bytes at the current cursor for a value computed later
 * (e.g. a change mask known only after walking all props). Returns a callback
 * that writes the actual value into the reserved slot without disturbing the
 * cursor position.
 */
const space =
  (width: 1 | 2 | 4 | 8) =>
  (v: ViewCursor): ((value: number | bigint) => true) => {
    const slot = v.cursor
    v.cursor += width
    return (value: number | bigint): true => {
      switch (width) {
        case 1:
          v.setUint8(slot, Number(value))
          break
        case 2:
          v.setUint16(slot, Number(value), true)
          break
        case 4:
          v.setUint32(slot, Number(value) >>> 0, true)
          break
        case 8:
          v.setBigUint64(slot, BigInt(value), true)
          break
      }
      return true
    }
  }

export const spaceUint8 = space(1)
export const spaceUint16 = space(2)
export const spaceUint32 = space(4)
export const spaceUint64 = space(8)

// ── Shadow-map-aware diff write ───────────────────────────────────────────────

/** Per-typed-array shadow buffer, lazily allocated. */
const getShadow = (v: ViewCursor, source: TypedArray): TypedArray => {
  let shadow = v.shadowMap.get(source)
  if (!shadow || shadow.length !== source.length) {
    // Allocate a shadow of matching constructor + length; initialise to NaN-ish
    // sentinel for floats / 0 for ints so first write is always recorded.
    const ctor = source.constructor as new (n: number) => TypedArray
    shadow = new ctor(source.length)
    if (shadow instanceof Float32Array || shadow instanceof Float64Array) {
      shadow.fill(Number.NaN)
    }
    v.shadowMap.set(source, shadow)
  }
  return shadow
}

const writeForCtor = (v: ViewCursor, source: TypedArray, value: number): void => {
  if (source instanceof Uint8Array || source instanceof Uint8ClampedArray) writeUint8(v, value)
  else if (source instanceof Int8Array) writeInt8(v, value)
  else if (source instanceof Uint16Array) writeUint16(v, value)
  else if (source instanceof Int16Array) writeInt16(v, value)
  else if (source instanceof Uint32Array || source instanceof Int32Array) writeUint32(v, value)
  else if (source instanceof Float32Array) writeFloat32(v, value)
  else if (source instanceof Float64Array) writeFloat64(v, value)
  else throw new Error('cursor: unsupported TypedArray kind in writeForCtor')
}

const readForCtor = (v: ViewCursor, source: TypedArray): number => {
  if (source instanceof Uint8Array || source instanceof Uint8ClampedArray) return readUint8(v)
  if (source instanceof Int8Array) return readInt8(v)
  if (source instanceof Uint16Array) return readUint16(v)
  if (source instanceof Int16Array) return readInt16(v)
  if (source instanceof Uint32Array || source instanceof Int32Array) return readUint32(v)
  if (source instanceof Float32Array) return readFloat32(v)
  if (source instanceof Float64Array) return readFloat64(v)
  throw new Error('cursor: unsupported TypedArray kind in readForCtor')
}

/**
 * Write `source[entity]` to the cursor IFF it differs from its shadowed
 * previous value (floats compared with `PROP_EPSILON` tolerance). Updates
 * the shadow on write. Returns true if a write happened.
 *
 * `ignoreHasChanged: true` forces the write regardless of diff — used for
 * periodic full-sync packets that must converge even without changes.
 */
export const writePropIfChanged = (
  v: ViewCursor,
  source: TypedArray,
  entity: number,
  ignoreHasChanged = false
): boolean => {
  const current = source[entity] as number
  const shadow = getShadow(v, source)
  const previous = shadow[entity] as number
  const isFloat = source instanceof Float32Array || source instanceof Float64Array
  let changed: boolean
  if (ignoreHasChanged) changed = true
  else if (isFloat)
    changed =
      Number.isNaN(previous) ||
      Number.isNaN(current) !== Number.isNaN(previous) ||
      Math.abs(current - previous) > PROP_EPSILON
  else changed = current !== previous
  if (!changed) return false
  writeForCtor(v, source, current)
  shadow[entity] = current
  return true
}

/**
 * Test if `source[entity]` differs from its shadowed previous value (with
 * `PROP_EPSILON` tolerance for floats) — pure, no side effects. Used by
 * grouped/compressed encoders that need to test multiple arrays before
 * deciding to emit one packed payload.
 */
export const isPropChanged = (v: ViewCursor, source: TypedArray, entity: number): boolean => {
  const current = source[entity] as number
  const shadow = getShadow(v, source)
  const previous = shadow[entity] as number
  const isFloat = source instanceof Float32Array || source instanceof Float64Array
  if (isFloat) {
    return (
      Number.isNaN(previous) ||
      Number.isNaN(current) !== Number.isNaN(previous) ||
      Math.abs(current - previous) > PROP_EPSILON
    )
  }
  return current !== previous
}

/** Commit `source[entity]` into the shadow map. Pair with `isPropChanged` after writing. */
export const commitPropShadow = (v: ViewCursor, source: TypedArray, entity: number): void => {
  const shadow = getShadow(v, source)
  shadow[entity] = source[entity] as number
}

/**
 * Read one value from the cursor into `source[entity]`. If `source` is one of
 * our resizable typed arrays (see `resizableArray` in `maths/common.ts`) and
 * the slot is beyond current length, grows the underlying buffer first —
 * otherwise the out-of-bounds index assignment is silently dropped.
 */
export const readPropInto = (v: ViewCursor, source: TypedArray, entity: number): void => {
  const value = readForCtor(v, source)
  if (entity >= source.length) {
    const resizable = source as TypedArray & { resize?: (n: number) => void }
    if (typeof resizable.resize === 'function') resizable.resize(entity + 1)
  }
  ;(source as unknown as Record<number, number>)[entity] = value
}

// ── Bit utilities ────────────────────────────────────────────────────────────-

/** True iff bit `bit` (0-indexed from LSB) is set in `mask`. */
export const checkBitflag = (mask: number, bit: number): boolean => (mask & (1 << bit)) !== 0

/** Reset all shadow tracking — useful when a peer disconnects + reconnects. */
export const clearShadowMap = (v: ViewCursor): void => {
  v.shadowMap.clear()
}
