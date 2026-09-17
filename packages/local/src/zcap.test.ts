import { describe, expect, it } from 'vitest'
import { keyPairFromSeed } from './did'
import { capabilityAllows, createRootCapability, delegateCapability, verifyCapability } from './zcap'

describe('ZCAP capabilities', () => {
  it('verifies a self-issued root capability', () => {
    const alice = keyPairFromSeed('zcap-alice')
    const cap = createRootCapability({
      invoker: alice.did,
      predicates: ['Transform'],
      scope: ['scene:main'],
      issuer: alice
    })
    expect(verifyCapability(cap, { now: 0 })).toBe(true)
  })

  it('verifies trusted-issuer constraint', () => {
    const issuer = keyPairFromSeed('zcap-issuer')
    const alice = keyPairFromSeed('zcap-alice')
    const cap = createRootCapability({
      invoker: alice.did,
      predicates: ['Transform'],
      scope: [],
      issuer
    })
    expect(verifyCapability(cap, { now: 0, trustedIssuers: [issuer.did] })).toBe(true)
    expect(verifyCapability(cap, { now: 0, trustedIssuers: [alice.did] })).toBe(false)
  })

  it('rejects expired capabilities', () => {
    const alice = keyPairFromSeed('zcap-alice')
    const cap = createRootCapability({
      invoker: alice.did,
      predicates: ['Transform'],
      scope: [],
      issuer: alice,
      expires: 1000
    })
    expect(verifyCapability(cap, { now: 500 })).toBe(true)
    expect(verifyCapability(cap, { now: 2000 })).toBe(false)
  })

  it('delegates a capability and verifies the chain', () => {
    const alice = keyPairFromSeed('zcap-alice')
    const bob = keyPairFromSeed('zcap-bob')
    const root = createRootCapability({
      invoker: alice.did,
      predicates: ['Transform', 'Health'],
      scope: ['scene:main'],
      issuer: alice,
      delegatable: true
    })
    const child = delegateCapability({
      parent: root,
      delegator: alice,
      invoker: bob.did,
      predicates: ['Transform']
    })
    expect(verifyCapability(child, { now: 0 })).toBe(true)
    expect(capabilityAllows(child, 'Transform', ['scene:main'])).toBe(true)
    expect(capabilityAllows(child, 'Health', ['scene:main'])).toBe(false)
  })

  it('rejects delegation of predicates not in parent', () => {
    const alice = keyPairFromSeed('zcap-alice')
    const bob = keyPairFromSeed('zcap-bob')
    const root = createRootCapability({
      invoker: alice.did,
      predicates: ['Transform'],
      scope: [],
      issuer: alice,
      delegatable: true
    })
    expect(() =>
      delegateCapability({ parent: root, delegator: alice, invoker: bob.did, predicates: ['Health'] })
    ).toThrow()
  })

  it('rejects delegation when parent is not delegatable', () => {
    const alice = keyPairFromSeed('zcap-alice')
    const bob = keyPairFromSeed('zcap-bob')
    const root = createRootCapability({
      invoker: alice.did,
      predicates: ['Transform'],
      scope: [],
      issuer: alice,
      delegatable: false
    })
    expect(() => delegateCapability({ parent: root, delegator: alice, invoker: bob.did })).toThrow()
  })

  it('rejects child expiry extending beyond parent', () => {
    const alice = keyPairFromSeed('zcap-alice')
    const bob = keyPairFromSeed('zcap-bob')
    const root = createRootCapability({
      invoker: alice.did,
      predicates: ['Transform'],
      scope: [],
      issuer: alice,
      delegatable: true,
      expires: 1000
    })
    expect(() => delegateCapability({ parent: root, delegator: alice, invoker: bob.did, expires: 2000 })).toThrow()
  })

  it('detects tampered signatures', () => {
    const alice = keyPairFromSeed('zcap-alice')
    const cap = createRootCapability({
      invoker: alice.did,
      predicates: ['Transform'],
      scope: [],
      issuer: alice
    })
    const tampered = { ...cap, predicates: ['Transform', 'Health'] }
    expect(verifyCapability(tampered, { now: 0 })).toBe(false)
  })

  it('capabilityAllows enforces scope subset', () => {
    const alice = keyPairFromSeed('zcap-alice')
    const cap = createRootCapability({
      invoker: alice.did,
      predicates: ['X'],
      scope: ['scene:a'],
      issuer: alice
    })
    expect(capabilityAllows(cap, 'X', ['scene:a'])).toBe(true)
    expect(capabilityAllows(cap, 'X', ['scene:a', 'child'])).toBe(true)
    expect(capabilityAllows(cap, 'X', ['scene:b'])).toBe(false)
    expect(capabilityAllows(cap, 'Y', ['scene:a'])).toBe(false)
  })
})
