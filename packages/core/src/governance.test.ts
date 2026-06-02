import { describe, expect, it } from 'vitest'
import { Schema } from './schema'
import { keyPairFromSeed, signTriple } from './did'
import { createWorld, destroyWorld } from './world'
import { createNamedEntity, setUID } from './identity'
import { createEntity } from './entity'
import { defineComponent } from './component'
import { addConstraint, resolveConstraints, validateEvent } from './governance'
import { createRootCapability } from './zcap'

// Health-gov is referenced by id in test triples (not directly imported)
defineComponent({
  id: 'Health-gov',
  schema: Schema.Object({ current: Schema.Number({ default: 100 }), max: Schema.Number({ default: 100 }) })
})

describe('Governance — constraint plumbing', () => {
  it('addConstraint creates an entity + HasConstraint pair on the scope', () => {
    const world = createWorld()
    const scene = createNamedEntity(world, 'scene:gov')
    addConstraint(world, scene, 'credential', { requiredCredential: 'verified', operations: ['spawn'] })
    const resolved = resolveConstraints(world, scene)
    expect(resolved).toHaveLength(1)
    expect(resolved[0].kind).toBe('credential')
    destroyWorld(world)
  })

  it('resolveConstraints walks the BelongsTo chain (most-specific first)', () => {
    const world = createWorld()
    const root = createNamedEntity(world, 'root')
    const scene = createEntity(world)
    setUID(world, scene, 'scene:s', { parent: root })
    addConstraint(world, root, 'credential', { requiredCredential: 'root-cred', operations: ['spawn'] })
    addConstraint(world, scene, 'temporal', { appliesTo: ['x'], maxCountPerWindow: 1 })
    const resolved = resolveConstraints(world, scene)
    expect(resolved.map((c) => c.kind)).toEqual(['temporal', 'credential'])
    destroyWorld(world)
  })
})

describe('Governance — validateEvent', () => {
  const mkTriple = (predicate: string, value: unknown, path: string[], seed = 'gov-alice') => {
    const kp = keyPairFromSeed(seed)
    return signTriple({ entityPath: path, predicate, value, op: 'set' }, kp, 1_000_000)
  }

  it('accepts when no constraints apply', () => {
    const world = createWorld()
    const triple = mkTriple('Health-gov', { current: 80 }, ['scene:gov', 'avatar'])
    expect(validateEvent(world, triple).allowed).toBe(true)
    destroyWorld(world)
  })

  it('credential constraint rejects when oracle returns false', () => {
    const world = createWorld()
    const scene = createNamedEntity(world, 'scene:cred')
    addConstraint(world, scene, 'credential', { requiredCredential: 'builder', operations: ['modify'] })
    const triple = mkTriple('Health-gov', { current: 50 }, ['scene:cred', 'avatar'])
    // Ensure the avatar entity path resolves under the scene scope
    setUID(world, createEntity(world), 'avatar', { parent: scene })
    const result = validateEvent(world, triple, { hasCredential: () => false })
    expect(result.allowed).toBe(false)
    expect(result.violations[0].kind).toBe('credential')
    destroyWorld(world)
  })

  it('credential constraint accepts when oracle returns true', () => {
    const world = createWorld()
    const scene = createNamedEntity(world, 'scene:cred')
    addConstraint(world, scene, 'credential', { requiredCredential: 'builder', operations: ['modify'] })
    setUID(world, createEntity(world), 'avatar', { parent: scene })
    const triple = mkTriple('Health-gov', { current: 50 }, ['scene:cred', 'avatar'])
    const result = validateEvent(world, triple, { hasCredential: () => true })
    expect(result.allowed).toBe(true)
    destroyWorld(world)
  })

  it('content constraint rejects out-of-range numeric fields', () => {
    const world = createWorld()
    const scene = createNamedEntity(world, 'scene:content')
    addConstraint(world, scene, 'content', {
      componentType: 'Health-gov',
      fieldConstraints: { current: { min: 0, max: 100 } }
    })
    setUID(world, createEntity(world), 'avatar', { parent: scene })
    const ok = mkTriple('Health-gov', { current: 50, max: 100 }, ['scene:content', 'avatar'])
    expect(validateEvent(world, ok).allowed).toBe(true)
    const bad = mkTriple('Health-gov', { current: 999, max: 100 }, ['scene:content', 'avatar'])
    expect(validateEvent(world, bad).allowed).toBe(false)
    destroyWorld(world)
  })

  it('temporal constraint enforces maxCountPerWindow from event log', () => {
    const world = createWorld()
    const scene = createNamedEntity(world, 'scene:temp')
    addConstraint(world, scene, 'temporal', { appliesTo: ['Health-gov'], maxCountPerWindow: 2, windowMs: 10_000 })
    setUID(world, createEntity(world), 'avatar', { parent: scene })
    // Manually seed event log
    const alice = keyPairFromSeed('gov-alice')
    for (let i = 0; i < 2; i++) {
      world.eventLog.push(
        signTriple(
          { entityPath: ['scene:temp', 'avatar'], predicate: 'Health-gov', value: { current: i }, op: 'set' },
          alice,
          1_000_000 + i
        )
      )
    }
    world.clock = { now: () => 1_000_005 } as typeof world.clock
    const triple = mkTriple('Health-gov', { current: 9 }, ['scene:temp', 'avatar'])
    const result = validateEvent(world, triple)
    expect(result.allowed).toBe(false)
    expect(result.violations[0].kind).toBe('temporal')
    destroyWorld(world)
  })

  it('capability constraint accepts triples authored by the cap invoker', () => {
    const world = createWorld()
    const scene = createNamedEntity(world, 'scene:cap')
    setUID(world, createEntity(world), 'avatar', { parent: scene })
    const alice = keyPairFromSeed('gov-alice')
    const cap = createRootCapability({
      invoker: alice.did,
      predicates: ['Health-gov'],
      scope: ['scene:cap'],
      issuer: alice
    })
    addConstraint(world, scene, 'capability', { capability: cap })
    const triple = mkTriple('Health-gov', { current: 80 }, ['scene:cap', 'avatar'])
    expect(validateEvent(world, triple, { trustedIssuers: [alice.did] }).allowed).toBe(true)
  })

  it('capability constraint rejects when invoker DID mismatches author', () => {
    const world = createWorld()
    const scene = createNamedEntity(world, 'scene:cap2')
    setUID(world, createEntity(world), 'avatar', { parent: scene })
    const alice = keyPairFromSeed('gov-alice')
    const bob = keyPairFromSeed('gov-bob')
    const cap = createRootCapability({
      invoker: alice.did,
      predicates: ['Health-gov'],
      scope: ['scene:cap2'],
      issuer: alice
    })
    addConstraint(world, scene, 'capability', { capability: cap })
    const triple = signTriple(
      { entityPath: ['scene:cap2', 'avatar'], predicate: 'Health-gov', value: { current: 80 }, op: 'set' },
      bob,
      1_000_000
    )
    expect(validateEvent(world, triple, { trustedIssuers: [alice.did] }).allowed).toBe(false)
  })

  it('emits governance.accept / governance.reject trace events', () => {
    const world = createWorld()
    const scene = createNamedEntity(world, 'scene:trace')
    addConstraint(world, scene, 'credential', { requiredCredential: 'x', operations: ['modify'] })
    setUID(world, createEntity(world), 'avatar', { parent: scene })
    const ok = mkTriple('Health-gov', { current: 1 }, ['scene:trace', 'avatar'])
    validateEvent(world, ok, { hasCredential: () => true })
    expect(world.trace.byKind('governance.accept')).toHaveLength(1)
    validateEvent(world, ok, { hasCredential: () => false })
    expect(world.trace.byKind('governance.reject')).toHaveLength(1)
    destroyWorld(world)
  })

  it('world-wide constraint via a top-level entity scope', () => {
    const world = createWorld()
    const worldEntity = createNamedEntity(world, 'world')
    addConstraint(world, worldEntity, 'credential', { requiredCredential: 'root', operations: ['spawn'] })
    setUID(world, createEntity(world), 'thing', { parent: worldEntity })
    const triple = signTriple(
      { entityPath: ['world', 'thing'], predicate: 'X', value: null, op: 'spawn' },
      keyPairFromSeed('any'),
      0
    )
    const result = validateEvent(world, triple, { hasCredential: () => false })
    expect(result.allowed).toBe(false)
    destroyWorld(world)
  })
})
