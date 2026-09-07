/**
 * DID and cryptographic primitives.
 *
 * Every state change in the engine can become a signed semantic triple. This
 * module supplies the minimum that such a triple needs: Ed25519 keypair
 * generation, sign and verify, and did:key encoding. The higher layers, such as
 * governance and ZCAP, build on top of it.
 *
 * The format follows the did:key specification for Ed25519, which produces
 * `did:key:z6Mk...`. That string is the multibase base58btc encoding of the
 * multicodec prefix 0xed01 plus the 32-byte public key.
 */

import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'

// Version 3 of @noble/ed25519 needs sha512 attached to `ed.hashes.sha512`,
// for a synchronous sign and verify.
ed.hashes.sha512 = sha512

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

// The did:key multicodec prefix for Ed25519: 0xed 0x01.
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
  const privateKey = seed ? seed.slice(0, 32) : ed.utils.randomSecretKey()
  if (privateKey.length !== 32) throw new Error('Ed25519 private key must be 32 bytes')
  const publicKey = ed.getPublicKey(privateKey)
  return {
    did: didFromPublicKey(publicKey),
    publicKey,
    privateKey
  }
}

/** Build a deterministic keypair from a string seed. Tests use it. */
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

/** A semantic triple, in the form (entity, predicate, value). */
export interface Triple {
  /** Entity path: the BelongsTo chain plus the UID. It gives a globally unique
   *  address. */
  entityPath: string[]
  /** Predicate URI: a component id or a relation name, such as 'Transform' or
   *  'ChildOf'. */
  predicate: string
  /** The value that the triple asserts. It holds the component data, the target
   *  path, or null for a removal. */
  value: unknown
  /** One of 'set', 'remove', 'spawn', or 'destroy'. */
  op: 'set' | 'remove' | 'spawn' | 'destroy'
}

export interface SignedTriple extends Triple {
  authorDID: DID
  timestamp: number
  /** Hex-encoded Ed25519 signature over the canonicalised bytes of the triple. */
  signature: string
}

const canonicaliseTriple = (triple: Triple, authorDID: string, timestamp: number): Uint8Array => {
  // Stable JSON for the signature. The keys stay sorted, and no whitespace
  // appears.
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
