import { describe, expect, it } from 'vitest'
import {
  checkBitflag,
  clearShadowMap,
  createViewCursor,
  PROP_EPSILON,
  readFloat32,
  readFloat64,
  readInt16,
  readPropInto,
  readUint16,
  readUint32,
  readUint8,
  rewindViewCursor,
  sliceViewCursor,
  spaceUint16,
  spaceUint32,
  spaceUint8,
  writeFloat32,
  writeFloat64,
  writeInt16,
  writePropIfChanged,
  writeUint16,
  writeUint32,
  writeUint8
} from './cursor'

describe('ViewCursor — primitives round-trip', () => {
  it('writes and reads every primitive type at the right byte width', () => {
    const v = createViewCursor()
    writeUint8(v, 200)
    writeInt16(v, -12345)
    writeUint16(v, 60000)
    writeUint32(v, 0xdeadbeef)
    writeFloat32(v, 3.5)
    writeFloat64(v, Math.PI)
    expect(v.cursor).toBe(1 + 2 + 2 + 4 + 4 + 8)

    const buf = sliceViewCursor(v)
    expect(v.cursor).toBe(0) // cursor reset after slice
    expect(buf.byteLength).toBe(1 + 2 + 2 + 4 + 4 + 8)

    const r = createViewCursor(buf)
    expect(readUint8(r)).toBe(200)
    expect(readInt16(r)).toBe(-12345)
    expect(readUint16(r)).toBe(60000)
    expect(readUint32(r)).toBe(0xdeadbeef)
    expect(readFloat32(r)).toBeCloseTo(3.5)
    expect(readFloat64(r)).toBeCloseTo(Math.PI)
  })
})

describe('ViewCursor — space* deferred writes', () => {
  it('spaceUint8 reserves a byte that can be filled later', () => {
    const v = createViewCursor()
    const writeLater = spaceUint8(v)
    writeUint8(v, 42)
    writeUint8(v, 43)
    writeLater(7) // fill the reserved byte AFTER subsequent writes
    expect(v.cursor).toBe(3)

    const r = createViewCursor(sliceViewCursor(v))
    expect(readUint8(r)).toBe(7)
    expect(readUint8(r)).toBe(42)
    expect(readUint8(r)).toBe(43)
  })

  it('spaceUint16 / spaceUint32 hold their slots correctly', () => {
    const v = createViewCursor()
    const u16 = spaceUint16(v)
    const u32 = spaceUint32(v)
    writeUint8(v, 1)
    u16(0xabcd)
    u32(0x12345678)

    const r = createViewCursor(sliceViewCursor(v))
    expect(readUint16(r)).toBe(0xabcd)
    expect(readUint32(r)).toBe(0x12345678)
    expect(readUint8(r)).toBe(1)
  })
})

describe('ViewCursor — rewindViewCursor', () => {
  it('returns a thunk that restores the cursor and reports false', () => {
    const v = createViewCursor()
    writeUint8(v, 1)
    const undo = rewindViewCursor(v)
    writeUint8(v, 2)
    writeUint8(v, 3)
    expect(v.cursor).toBe(3)
    const result = undo()
    expect(result).toBe(false)
    expect(v.cursor).toBe(1)
    writeUint8(v, 9)

    const r = createViewCursor(sliceViewCursor(v))
    expect(readUint8(r)).toBe(1)
    expect(readUint8(r)).toBe(9)
  })
})

describe('writePropIfChanged — shadow diff', () => {
  it('writes the first time and skips identical follow-ups', () => {
    const v = createViewCursor()
    const arr = new Float32Array(4)
    arr[3] = 7.25

    expect(writePropIfChanged(v, arr, 3)).toBe(true)
    expect(v.cursor).toBe(4) // wrote 4 bytes
    const first = sliceViewCursor(v)

    expect(writePropIfChanged(v, arr, 3)).toBe(false) // unchanged — no write
    expect(v.cursor).toBe(0)

    const r = createViewCursor(first)
    expect(readFloat32(r)).toBeCloseTo(7.25)
  })

  it('detects changes beyond PROP_EPSILON, ignores noise inside it', () => {
    const v = createViewCursor()
    const arr = new Float64Array(2)
    arr[0] = 1.0
    expect(writePropIfChanged(v, arr, 0)).toBe(true)
    sliceViewCursor(v)

    arr[0] = 1.0 + PROP_EPSILON / 2
    expect(writePropIfChanged(v, arr, 0)).toBe(false) // jitter under epsilon
    expect(v.cursor).toBe(0)

    arr[0] = 1.0 + PROP_EPSILON * 10
    expect(writePropIfChanged(v, arr, 0)).toBe(true) // real change
    expect(v.cursor).toBe(8)
  })

  it('ignoreHasChanged=true forces the write regardless of diff (full-sync)', () => {
    const v = createViewCursor()
    const arr = new Float32Array(1)
    arr[0] = 1.0
    expect(writePropIfChanged(v, arr, 0)).toBe(true)
    sliceViewCursor(v)
    expect(writePropIfChanged(v, arr, 0)).toBe(false) // identical
    expect(writePropIfChanged(v, arr, 0, true)).toBe(true) // forced
    expect(v.cursor).toBe(4)
  })

  it('uses the correct typed-array byte width per kind', () => {
    const v = createViewCursor()
    const u8 = new Uint8Array(1)
    const i16 = new Int16Array(1)
    const u32 = new Uint32Array(1)
    const f64 = new Float64Array(1)
    u8[0] = 200
    i16[0] = -1
    u32[0] = 0xdeadbeef
    f64[0] = Math.PI

    expect(writePropIfChanged(v, u8, 0)).toBe(true)
    expect(writePropIfChanged(v, i16, 0)).toBe(true)
    expect(writePropIfChanged(v, u32, 0)).toBe(true)
    expect(writePropIfChanged(v, f64, 0)).toBe(true)
    expect(v.cursor).toBe(1 + 2 + 4 + 8)

    const r = createViewCursor(sliceViewCursor(v))
    expect(readUint8(r)).toBe(200)
    expect(readInt16(r)).toBe(-1)
    expect(readUint32(r)).toBe(0xdeadbeef)
    expect(readFloat64(r)).toBeCloseTo(Math.PI)
  })

  it('readPropInto round-trips through writePropIfChanged', () => {
    const writeArr = new Float32Array(3)
    const readArr = new Float32Array(3)
    writeArr[2] = 9.875

    const w = createViewCursor()
    expect(writePropIfChanged(w, writeArr, 2)).toBe(true)
    const buf = sliceViewCursor(w)

    const r = createViewCursor(buf)
    readPropInto(r, readArr, 2)
    expect(readArr[2]).toBeCloseTo(9.875)
  })

  it('clearShadowMap forces the next write to be a full sync', () => {
    const v = createViewCursor()
    const arr = new Float32Array(1)
    arr[0] = 1.0
    expect(writePropIfChanged(v, arr, 0)).toBe(true)
    sliceViewCursor(v)
    expect(writePropIfChanged(v, arr, 0)).toBe(false)
    clearShadowMap(v)
    expect(writePropIfChanged(v, arr, 0)).toBe(true) // shadow forgotten → re-write
  })
})

describe('checkBitflag', () => {
  it('reads individual bits from a mask', () => {
    expect(checkBitflag(0b1010, 0)).toBe(false)
    expect(checkBitflag(0b1010, 1)).toBe(true)
    expect(checkBitflag(0b1010, 2)).toBe(false)
    expect(checkBitflag(0b1010, 3)).toBe(true)
  })
})
