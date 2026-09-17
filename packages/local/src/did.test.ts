import { describe, expect, it } from 'vitest'
import {
  didFromPublicKey,
  generateKeyPair,
  keyPairFromSeed,
  publicKeyFromDID,
  sign,
  signTriple,
  verify,
  verifyByDID,
  verifyTriple,
  type Triple
} from './did'

describe('DID & Ed25519', () => {
  it('generates a valid did:key for a generated keypair', () => {
    const kp = generateKeyPair()
    expect(kp.did.startsWith('did:key:z')).toBe(true)
    expect(kp.publicKey.length).toBe(32)
    expect(kp.privateKey.length).toBe(32)
    expect(didFromPublicKey(kp.publicKey)).toBe(kp.did)
  })

  it('round-trips public key through did:key encoding', () => {
    const kp = generateKeyPair()
    const recovered = publicKeyFromDID(kp.did)
    expect(Array.from(recovered)).toEqual(Array.from(kp.publicKey))
  })

  it('keyPairFromSeed is deterministic', () => {
    const a = keyPairFromSeed('alice-test-seed')
    const b = keyPairFromSeed('alice-test-seed')
    expect(a.did).toBe(b.did)
    expect(Array.from(a.publicKey)).toEqual(Array.from(b.publicKey))
  })

  it('signs and verifies a message', () => {
    const kp = generateKeyPair()
    const msg = new TextEncoder().encode('hello, world')
    const sig = sign(msg, kp.privateKey)
    expect(verify(sig, msg, kp.publicKey)).toBe(true)
    expect(verifyByDID(sig, msg, kp.did)).toBe(true)
    // tampered message fails
    const tampered = new TextEncoder().encode('hello, world!')
    expect(verifyByDID(sig, tampered, kp.did)).toBe(false)
  })

  it('rejects garbage signatures without throwing', () => {
    const kp = generateKeyPair()
    expect(verify(new Uint8Array(64), new Uint8Array(10), kp.publicKey)).toBe(false)
  })

  it('signs and verifies a semantic triple', () => {
    const kp = keyPairFromSeed('alice')
    const triple: Triple = {
      entityPath: ['scene:main', 'avatar:alice'],
      predicate: 'Health',
      value: { current: 50, max: 100 },
      op: 'set'
    }
    const signed = signTriple(triple, kp, 1700000000)
    expect(signed.authorDID).toBe(kp.did)
    expect(signed.timestamp).toBe(1700000000)
    expect(verifyTriple(signed)).toBe(true)
    // mutate value — verification fails
    const tampered = { ...signed, value: { current: 9999, max: 100 } }
    expect(verifyTriple(tampered)).toBe(false)
  })

  it('triple signing is canonical (order-independent for object keys)', () => {
    const kp = keyPairFromSeed('alice')
    const a = signTriple({ entityPath: ['x'], predicate: 'P', value: { a: 1, b: 2 }, op: 'set' }, kp, 1)
    const b = signTriple({ entityPath: ['x'], predicate: 'P', value: { b: 2, a: 1 }, op: 'set' }, kp, 1)
    expect(a.signature).toBe(b.signature)
  })

  it('rejects malformed did:key strings', () => {
    expect(() => publicKeyFromDID('did:web:example.com')).toThrow()
    expect(() => publicKeyFromDID('did:key:zBADBASE58!!')).toThrow()
  })
})
