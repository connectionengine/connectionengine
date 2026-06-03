/**
 * DID & cryptographic primitives.
 *
 * Every state change in the engine can be a signed semantic triple. This module
 * provides the minimum needed: Ed25519 keypair generation, sign/verify, and
 * did:key encoding. Higher layers (governance, ZCAP) build on top.
 *
 * The format follows did:key spec for Ed25519: did:key:z6Mk... (multibase base58btc
 * of multicodec 0xed01 + 32-byte public key).
 */

import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2'

// @noble/ed25519 v2 needs a sync sha512 hook for sync sign/verify.
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(concat(...m))

const concat = (...arrays: Uint8Array[]): Uint8Array => {
  const total = arrays.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrays) {
    out.set(a, off)
    off += a.length
  }
  return out
}

// ── multibase / base58btc ─────────────────────────────────────────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

const base58btcEncode = (bytes: Uint8Array): string => {
  if (bytes.length === 0) return ''
  const digits: number[] = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8
      digits[i] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let out = ''
  for (const b of bytes) {
    if (b === 0) out += '1'
    else break
  }
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]]
  return out
}

const base58btcDecode = (str: string): Uint8Array => {
  const bytes: number[] = [0]
  for (const ch of str) {
    const value = BASE58_ALPHABET.indexOf(ch)
    if (value === -1) throw new Error(`Invalid base58 character: ${ch}`)
    let carry = value
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  let leading = 0
  for (const ch of str) {
    if (ch === '1') leading++
    else break
  }
  const result = new Uint8Array(leading + bytes.length)
  for (let i = 0; i < bytes.length; i++) result[leading + i] = bytes[bytes.length - 1 - i]
  return result
}

// did:key multicodec prefix for Ed25519: 0xed 0x01
const ED25519_MULTICODEC = new Uint8Array([0xed, 0x01])

// ── hex helpers ───────────────────────────────────────────────────────────────

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

// ── public API ────────────────────────────────────────────────────────────────

export type DID = `did:key:z${string}`

export interface KeyPair {
  readonly did: DID
  readonly publicKey: Uint8Array
  readonly privateKey: Uint8Array
}

export const generateKeyPair = (seed?: Uint8Array): KeyPair => {
  const privateKey = seed ? seed.slice(0, 32) : ed.utils.randomPrivateKey()
  if (privateKey.length !== 32) throw new Error('Ed25519 private key must be 32 bytes')
  const publicKey = ed.getPublicKey(privateKey)
  return {
    did: didFromPublicKey(publicKey),
    publicKey,
    privateKey
  }
}

/** Deterministic keypair from a string seed — useful in tests. */
export const keyPairFromSeed = (seed: string): KeyPair => {
  const encoded = new TextEncoder().encode(seed.padEnd(32, '\0'))
  return generateKeyPair(encoded.slice(0, 32))
}

export const didFromPublicKey = (publicKey: Uint8Array): DID => {
  const multicodec = concat(ED25519_MULTICODEC, publicKey)
  return `did:key:z${base58btcEncode(multicodec)}` as DID
}

export const publicKeyFromDID = (did: string): Uint8Array => {
  if (!did.startsWith('did:key:z')) throw new Error(`Not a did:key: ${did}`)
  const multibase = did.slice('did:key:z'.length)
  const decoded = base58btcDecode(multibase)
  if (decoded[0] !== ED25519_MULTICODEC[0] || decoded[1] !== ED25519_MULTICODEC[1]) {
    throw new Error('Unsupported did:key multicodec — only Ed25519 supported')
  }
  return decoded.slice(2)
}

export const sign = (message: Uint8Array, privateKey: Uint8Array): Uint8Array => ed.sign(message, privateKey)

export const verify = (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean => {
  try {
    return ed.verify(signature, message, publicKey)
  } catch {
    return false
  }
}

export const verifyByDID = (signature: Uint8Array, message: Uint8Array, did: string): boolean => {
  try {
    return verify(signature, message, publicKeyFromDID(did))
  } catch {
    return false
  }
}

// ── triple signing ────────────────────────────────────────────────────────────

/** A semantic triple: <entity, predicate, value>. */
export interface Triple {
  /** Entity path (BelongsTo chain + UID) — globally unique address */
  entityPath: string[]
  /** Predicate URI (component id or relation name, e.g. 'Transform', 'ChildOf') */
  predicate: string
  /** The value being asserted (component data, target path, or null for removal) */
  value: unknown
  /** 'set' | 'remove' | 'spawn' | 'destroy' */
  op: 'set' | 'remove' | 'spawn' | 'destroy'
}

export interface SignedTriple extends Triple {
  authorDID: DID
  timestamp: number
  /** Hex-encoded Ed25519 signature over canonicalised triple bytes. */
  signature: string
}

const canonicaliseTriple = (triple: Triple, authorDID: string, timestamp: number): Uint8Array => {
  // Stable JSON for signing — keys sorted, no whitespace
  const payload = {
    authorDID,
    entityPath: triple.entityPath,
    op: triple.op,
    predicate: triple.predicate,
    timestamp,
    value: triple.value
  }
  return new TextEncoder().encode(stableStringify(payload))
}

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value instanceof Uint8Array) return JSON.stringify(toHex(value))
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

export const signTriple = (triple: Triple, keyPair: KeyPair, timestamp: number): SignedTriple => {
  const bytes = canonicaliseTriple(triple, keyPair.did, timestamp)
  const signature = sign(bytes, keyPair.privateKey)
  return {
    ...triple,
    authorDID: keyPair.did,
    timestamp,
    signature: toHex(signature)
  }
}

export const verifyTriple = (signed: SignedTriple): boolean => {
  const bytes = canonicaliseTriple(
    { entityPath: signed.entityPath, predicate: signed.predicate, value: signed.value, op: signed.op },
    signed.authorDID,
    signed.timestamp
  )
  return verifyByDID(fromHex(signed.signature), bytes, signed.authorDID)
}

export { toHex, fromHex, stableStringify }
