/**
 * Authored-channel codec — a string-shaped binary envelope for the
 * low-frequency, event-sourced channel.
 *
 * It builds on the same `ViewCursor` primitives as the runtime binary codec in
 * `binary.ts`. The two channels share that infrastructure, and differ in their
 * semantics:
 *
 *   - An authored event carries semantic intent: predicate URIs, entity paths,
 *     and JSON-encoded values. Strings therefore dominate its payload.
 *   - The runtime binary channel uses change-mask delta encoding, and puts no
 *     strings on the wire. It addresses an entity through a per-connection
 *     NetworkIdTable.
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
 *       u8  op   (0=set, 1=remove, 2=spawn, 3=destroy)
 *       str predicate
 *       str[] entityPath
 *       str valueJson
 */

import type { AuthoredEnvelope, AuthoredEvent } from '../ecs/world'
import {
  createViewCursor,
  readBytes,
  readFloat64,
  readString,
  readStringArray,
  readUint16,
  readUint8,
  sliceViewCursor,
  writeBytes,
  writeFloat64,
  writeString,
  writeStringArray,
  writeUint16,
  writeUint8
} from './cursor'

const MAGIC = new Uint8Array([0x43, 0x45, 0x52, 0x45]) // 'CERE'
const KIND_AUTHORED = 1

const OP_CODES = { set: 0, remove: 1, spawn: 2, destroy: 3 } as const satisfies Record<AuthoredEvent['op'], number>
const OP_FROM_CODE: readonly AuthoredEvent['op'][] = ['set', 'remove', 'spawn', 'destroy']

/** Default buffer for an authored envelope. 2 MiB holds about 40k events at
 *  typical sizes. */
const AUTHORED_BUFFER_BYTES = 2 * 1024 * 1024

export const serializeAuthoredEnvelope = (envelope: AuthoredEnvelope): ArrayBuffer => {
  const view = createViewCursor(new ArrayBuffer(AUTHORED_BUFFER_BYTES))
  writeBytes(view, MAGIC)
  writeUint8(view, KIND_AUTHORED)
  writeString(view, envelope.fromPeer)
  writeUint16(view, envelope.events.length)
  for (const ev of envelope.events) {
    writeString(view, ev.author)
    writeFloat64(view, ev.timestamp)
    writeUint8(view, OP_CODES[ev.op])
    writeString(view, ev.predicate)
    writeStringArray(view, ev.entityPath)
    writeString(view, JSON.stringify(ev.value ?? null))
  }
  return sliceViewCursor(view)
}

export const deserializeAuthoredEnvelope = (buffer: ArrayBuffer): AuthoredEnvelope => {
  const view = createViewCursor(buffer)
  const magic = readBytes(view, 4)
  for (let i = 0; i < 4; i++) {
    if (magic[i] !== MAGIC[i]) throw new Error('codec: bad magic bytes (not a Connection Engine envelope)')
  }
  const kind = readUint8(view)
  if (kind !== KIND_AUTHORED) throw new Error(`codec: expected authored envelope (kind 1), got kind ${kind}`)
  const fromPeer = readString(view)
  const count = readUint16(view)
  const events: AuthoredEvent[] = []
  for (let i = 0; i < count; i++) {
    const author = readString(view)
    const timestamp = readFloat64(view)
    const op = OP_FROM_CODE[readUint8(view)]
    if (!op) throw new Error(`codec: unknown op code at event ${i}`)
    const predicate = readString(view)
    const entityPath = readStringArray(view)
    const value = JSON.parse(readString(view))
    events.push({ author, timestamp, op, predicate, entityPath, value })
  }
  return { fromPeer, events }
}

/** Read the envelope kind of a buffer, without a full deserialisation. */
export const envelopeKind = (buffer: ArrayBuffer): 'authored' | 'unknown' => {
  if (buffer.byteLength < 5) return 'unknown'
  const view = createViewCursor(buffer)
  try {
    const magic = readBytes(view, 4)
    for (let i = 0; i < 4; i++) if (magic[i] !== MAGIC[i]) return 'unknown'
    if (readUint8(view) === KIND_AUTHORED) return 'authored'
  } catch {
    return 'unknown'
  }
  return 'unknown'
}
