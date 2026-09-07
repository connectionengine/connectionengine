/**
 * ViewCursor — a DataView with a cursor position, and a shadow map that tracks
 * changes.
 *
 * The pattern comes from the networking layer of EnchantmentEngine and IR
 * Engine. Two primitives matter most:
 *
 *   1. **`writePropIfChanged(view, typedArray, entity, ignore?)`** —
 *      it compares the current `typedArray[entity]` against a per-array
 *      shadow value. It writes only on a change, with an epsilon tolerance
 *      for floats. It returns whether it wrote. The caller collects those
 *      return bits to build one change-mask byte, and writes that byte ONCE
 *      at the front of the block of the component.
 *
 *   2. **`spaceUint8/16/32(view)`** — it reserves N bytes at the current
 *      cursor, and returns a deferred-write callback. That lets you write a
 *      change mask AFTER you walk every prop, so the mask reflects what you
 *      actually wrote.
 *
 * Together they give per-field delta encoding, and allocate no strings on the
 * wire.
 */

import type { TypedArray } from '../maths/common'

// ── Type ──────────────────────────────────────────────────────────────────────

/** A DataView, extended with a cursor position and a shadow store that tracks
 *  differences. */
export type ViewCursor = DataView & {
  cursor: number
  shadowMap: Map<TypedArray, TypedArray>
}

/** Default initial buffer for `createViewCursor`. 100 KiB suits a typical
 *  per-tick packet. */
export const DEFAULT_VIEW_CURSOR_BYTES = 100_000

/** Float comparison tolerance for `writePropIfChanged`. A difference below this
 *  value counts as no change. */
export const PROP_EPSILON = 1e-4

// ── Construction / cursor management ─────────────────────────────────────────-

export const createViewCursor = (buffer: ArrayBuffer = new ArrayBuffer(DEFAULT_VIEW_CURSOR_BYTES)): ViewCursor => {
  const view = new DataView(buffer) as ViewCursor
  view.cursor = 0
  view.shadowMap = new Map()
  return view
}

/** Return the slice written so far, and reset the cursor to 0 for the next
 *  packet. */
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
 * Capture the current cursor, and return a function that restores it. The
 * caller uses it to undo a speculative write when a component block ends up
 * empty. No prop changed, so the caller discards the reserved change-mask
 * space.
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

/** Read `n` bytes from the cursor as a subarray. The result is a zero-copy view
 *  onto the buffer. */
export const readBytes = (v: ViewCursor, n: number): Uint8Array => {
  const out = new Uint8Array(v.buffer, v.cursor, n)
  v.cursor += n
  return out
}

/**
 * Encode `s` as UTF-8, and prefix it with its byte length as a `uint16`. The
 * length therefore caps at 65535 bytes, which suffices for an entity-path
 * segment, a predicate URI, or a DID.
 */
export const writeString = (v: ViewCursor, s: string): ViewCursor => {
  const bytes = textEncoder.encode(s)
  writeUint16(v, bytes.byteLength)
  return writeBytes(v, bytes)
}

/** The inverse of `writeString`. It copies the bytes, because TextDecoder does
 *  not retain the view. */
export const readString = (v: ViewCursor): string => {
  const n = readUint16(v)
  return textDecoder.decode(readBytes(v, n))
}

/** An array of length-prefixed strings, itself prefixed by a u16 length. */
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
 * Reserve `width` bytes at the current cursor, for a value that the caller
 * computes later. A change mask is one example, because it is known only after
 * a walk of every prop. The function returns a callback that writes the real
 * value into the reserved slot, and leaves the cursor position unchanged.
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

/** Shadow buffer for one typed array. It allocates on first use. */
const getShadow = (v: ViewCursor, source: TypedArray): TypedArray => {
  let shadow = v.shadowMap.get(source)
  if (!shadow || shadow.length !== source.length) {
    // Allocate a shadow with a matching constructor and length. Initialise it
    // to a NaN-like sentinel for floats, and to 0 for integers, so that the
    // first write always records.
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
 * Write `source[entity]` to the cursor if, and only if, it differs from its
 * shadowed previous value. The comparison uses the `PROP_EPSILON` tolerance for
 * floats. The function updates the shadow on a write, and returns true when it
 * wrote.
 *
 * `ignoreHasChanged: true` forces the write, whatever the difference. A
 * periodic full-sync packet uses it, because such a packet must converge even
 * when nothing changed.
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
 * Test whether `source[entity]` differs from its shadowed previous value. The
 * comparison uses the `PROP_EPSILON` tolerance for floats. The function is
 * pure, and has no side effects. A grouped or compressed encoder uses it,
 * because such an encoder must test several arrays before it decides to emit
 * one packed payload.
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

/** Commit `source[entity]` into the shadow map. Use it with `isPropChanged`
 *  after a write. */
export const commitPropShadow = (v: ViewCursor, source: TypedArray, entity: number): void => {
  const shadow = getShadow(v, source)
  shadow[entity] = source[entity] as number
}

/**
 * Read one value from the cursor into `source[entity]`. When `source` is a
 * resizable typed array, as `resizableArray` in `maths/common.ts` creates, and
 * the slot lies beyond the current length, the function grows the underlying
 * buffer first. Without that growth, the out-of-bounds index assignment would
 * disappear silently.
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

/** True if and only if `mask` sets bit `bit`, counted from the LSB at index 0. */
export const checkBitflag = (mask: number, bit: number): boolean => (mask & (1 << bit)) !== 0

/** Reset every shadow record. Use it when a peer disconnects and reconnects. */
export const clearShadowMap = (v: ViewCursor): void => {
  v.shadowMap.clear()
}
