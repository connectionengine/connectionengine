/**
 * Authored-channel codec — string-shaped binary envelope for the
 * low-frequency event-sourced channel.
 *
 * Authored mutations are infrequent (governance changes, ownership transfers,
 * UID assignments, prefab spawns). They carry semantic intent — predicate
 * URIs, entity paths as path-segment arrays, JSON-encoded values. Per-event
 * payload is dominated by the value JSON; the string overhead is amortised.
 *
 * The high-frequency runtime channel (60 Hz position/velocity/rotation
 * deltas) does NOT use this codec — see `engine/binary.ts` for a
 * cursor-based per-bit-change-mask format with no strings on the wire.
 *
 * Format (little-endian):
 *
 *   Header (5 bytes):
 *     u8 magic[4] = "CERE"
 *     u8 kind     (1 = authored)
 *
 *   Body:
 *     str fromPeer
 *     u16 eventCount
 *     for each event:
 *       str author
 *       f64 timestamp
 *       u8  op (0=set, 1=remove, 2=spawn, 3=destroy)
 *       str predicate
 *       str[] entityPath  (u16 count + u16-prefixed segments)
 *       str valueJson
 *
 *   string format:
 *     u16 utf8ByteLength
 *     u8[utf8ByteLength] utf8 bytes
 */

import type { AuthoredEnvelope, AuthoredEvent } from '../ecs/world'

const MAGIC = new Uint8Array([0x43, 0x45, 0x52, 0x45]) // 'CERE'
const KIND_AUTHORED = 1

const OP_SET = 0
const OP_REMOVE = 1
const OP_SPAWN = 2
const OP_DESTROY = 3

const opToCode = (op: AuthoredEvent['op']): number => {
  if (op === 'set') return OP_SET
  if (op === 'remove') return OP_REMOVE
  if (op === 'spawn') return OP_SPAWN
  return OP_DESTROY
}
const codeToOp = (code: number): AuthoredEvent['op'] => {
  if (code === OP_SET) return 'set'
  if (code === OP_REMOVE) return 'remove'
  if (code === OP_SPAWN) return 'spawn'
  if (code === OP_DESTROY) return 'destroy'
  throw new Error(`unknown op code: ${code}`)
}

// ── Write buffer (grows on demand) ───────────────────────────────────────────-

class Writer {
  private buf: ArrayBuffer
  private view: DataView
  private offset = 0
  private bytes: Uint8Array

  constructor(initialBytes = 256) {
    // Use plain ArrayBuffer + grow-by-copy. Growable ArrayBuffer support
    // (maxByteLength) exists in Node 22+ but TypeScript libs don't always
    // expose the second-arg overload; the copy fallback is fast enough at
    // typical envelope sizes (<64KB).
    this.buf = new ArrayBuffer(initialBytes)
    this.view = new DataView(this.buf)
    this.bytes = new Uint8Array(this.buf)
  }

  private grow(needed: number): void {
    const required = this.offset + needed
    if (required <= this.buf.byteLength) return
    let target = this.buf.byteLength
    while (target < required) target *= 2
    const next = new ArrayBuffer(target)
    new Uint8Array(next).set(this.bytes.subarray(0, this.offset))
    this.buf = next
    this.view = new DataView(this.buf)
    this.bytes = new Uint8Array(this.buf)
  }

  u8(v: number): void {
    this.grow(1)
    this.view.setUint8(this.offset, v)
    this.offset += 1
  }
  u16(v: number): void {
    this.grow(2)
    this.view.setUint16(this.offset, v, true)
    this.offset += 2
  }
  f64(v: number): void {
    this.grow(8)
    this.view.setFloat64(this.offset, v, true)
    this.offset += 8
  }
  bytes_(b: Uint8Array): void {
    this.grow(b.byteLength)
    this.bytes.set(b, this.offset)
    this.offset += b.byteLength
  }
  str(s: string): void {
    const enc = new TextEncoder().encode(s)
    this.u16(enc.byteLength)
    this.bytes_(enc)
  }
  stringArray(arr: readonly string[]): void {
    this.u16(arr.length)
    for (const s of arr) this.str(s)
  }
  finish(): ArrayBuffer {
    return this.buf.slice(0, this.offset)
  }
}

// ── Read cursor ───────────────────────────────────────────────────────────────

class Reader {
  private view: DataView
  private bytes: Uint8Array
  private offset = 0

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer)
    this.bytes = new Uint8Array(buffer)
  }

  u8(): number {
    const v = this.view.getUint8(this.offset)
    this.offset += 1
    return v
  }
  u16(): number {
    const v = this.view.getUint16(this.offset, true)
    this.offset += 2
    return v
  }
  f64(): number {
    const v = this.view.getFloat64(this.offset, true)
    this.offset += 8
    return v
  }
  bytes_(n: number): Uint8Array {
    const slice = this.bytes.subarray(this.offset, this.offset + n)
    this.offset += n
    return slice
  }
  str(): string {
    const n = this.u16()
    return new TextDecoder().decode(this.bytes_(n))
  }
  stringArray(): string[] {
    const n = this.u16()
    const out: string[] = []
    for (let i = 0; i < n; i++) out.push(this.str())
    return out
  }
}

// ── Header ────────────────────────────────────────────────────────────────────

const writeHeader = (w: Writer, kind: number): void => {
  w.bytes_(MAGIC)
  w.u8(kind)
}

const readHeader = (r: Reader): number => {
  for (let i = 0; i < 4; i++) {
    if (r.u8() !== MAGIC[i]) throw new Error('codec: bad magic bytes (not a Connection Engine envelope)')
  }
  return r.u8()
}

// ── Authored ──────────────────────────────────────────────────────────────────

export const serializeAuthoredEnvelope = (envelope: AuthoredEnvelope): ArrayBuffer => {
  const w = new Writer()
  writeHeader(w, KIND_AUTHORED)
  w.str(envelope.fromPeer)
  w.u16(envelope.events.length)
  for (const ev of envelope.events) {
    w.str(ev.author)
    w.f64(ev.timestamp)
    w.u8(opToCode(ev.op))
    w.str(ev.predicate)
    w.stringArray(ev.entityPath)
    w.str(JSON.stringify(ev.value ?? null))
  }
  return w.finish()
}

export const deserializeAuthoredEnvelope = (buffer: ArrayBuffer): AuthoredEnvelope => {
  const r = new Reader(buffer)
  const kind = readHeader(r)
  if (kind !== KIND_AUTHORED) throw new Error(`codec: expected authored envelope (kind 1), got kind ${kind}`)
  const fromPeer = r.str()
  const count = r.u16()
  const events: AuthoredEvent[] = []
  for (let i = 0; i < count; i++) {
    const author = r.str()
    const timestamp = r.f64()
    const op = codeToOp(r.u8())
    const predicate = r.str()
    const entityPath = r.stringArray()
    const value = JSON.parse(r.str())
    events.push({ author, timestamp, op, predicate, entityPath, value })
  }
  return { fromPeer, events }
}

// ── Inspection ────────────────────────────────────────────────────────────────

/** Peek at a buffer's envelope kind without fully deserialising. */
export const envelopeKind = (buffer: ArrayBuffer): 'authored' | 'unknown' => {
  if (buffer.byteLength < 5) return 'unknown'
  const r = new Reader(buffer)
  try {
    if (readHeader(r) === KIND_AUTHORED) return 'authored'
  } catch {
    return 'unknown'
  }
  return 'unknown'
}
