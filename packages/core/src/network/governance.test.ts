import { describe, expect, it } from 'vitest'
import { Schema } from '../schema'
import { createAnonAgent, createWorld, destroyWorld, type AuthoredEvent } from '../ecs/world'
import { createNamedEntity, setUID } from '../ecs/identity'
import { createEntity } from '../ecs/entity'
import { defineComponent } from '../ecs/component'
import { addConstraint, resolveConstraints, validateEvent } from './governance'

// Health-gov is referenced by id in test events (not directly used)
defineComponent({
  id: 'Health-gov',
  schema: Schema.Object({ current: Schema.Number({ default: 100 }), max: Schema.Number({ default: 100 }) })
})

const mkWorld = () => createWorld({ agent: createAnonAgent('test') })

const mkEvent = (predicate: string, value: unknown, path: string[], author = 'did:test:alice'): AuthoredEvent => ({
  entityPath: path,
  predicate,
  value,
  op: 'set',
  author,
  timestamp: 1_000_000
})

describe('Governance — constraint plumbing', () => {
  it('addConstraint creates an entity + HasConstraint pair on the scope', () => {
    const world = mkWorld()
    const scene = createNamedEntity(world, 'scene:gov')
    addConstraint(world, scene, 'credential', { requiredCredential: 'verified', operations: ['spawn'] })
    const resolved = resolveConstraints(world, scene)
    expect(resolved).toHaveLength(1)
    expect(resolved[0].kind).toBe('credential')
    destroyWorld(world)
  })

  it('resolveConstraints walks the BelongsTo chain (most-specific first)', () => {
    const world = mkWorld()
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
  it('accepts when no constraints apply', () => {
    const world = mkWorld()
    expect(validateEvent(world, mkEvent('Health-gov', { current: 80 }, ['scene:gov', 'avatar'])).allowed).toBe(true)
    destroyWorld(world)
  })

  it('credential constraint rejects when oracle returns false', () => {
    const world = mkWorld()
    const scene = createNamedEntity(world, 'scene:cred')
    addConstraint(world, scene, 'credential', { requiredCredential: 'builder', operations: ['modify'] })
    setUID(world, createEntity(world), 'avatar', { parent: scene })
    const result = validateEvent(world, mkEvent('Health-gov', { current: 50 }, ['scene:cred', 'avatar']), {
      hasCredential: () => false
    })
    expect(result.allowed).toBe(false)
    expect(result.violations[0].kind).toBe('credential')
    destroyWorld(world)
  })

  it('credential constraint accepts when oracle returns true', () => {
    const world = mkWorld()
    const scene = createNamedEntity(world, 'scene:cred')
    addConstraint(world, scene, 'credential', { requiredCredential: 'builder', operations: ['modify'] })
    setUID(world, createEntity(world), 'avatar', { parent: scene })
    const result = validateEvent(world, mkEvent('Health-gov', { current: 50 }, ['scene:cred', 'avatar']), {
      hasCredential: () => true
    })
    expect(result.allowed).toBe(true)
    destroyWorld(world)
  })

  it('content constraint rejects out-of-range numeric fields', () => {
    const world = mkWorld()
    const scene = createNamedEntity(world, 'scene:content')
    addConstraint(world, scene, 'content', {
      componentType: 'Health-gov',
      fieldConstraints: { current: { min: 0, max: 100 } }
    })
    setUID(world, createEntity(world), 'avatar', { parent: scene })
    expect(
      validateEvent(world, mkEvent('Health-gov', { current: 50, max: 100 }, ['scene:content', 'avatar'])).allowed
    ).toBe(true)
    expect(
      validateEvent(world, mkEvent('Health-gov', { current: 999, max: 100 }, ['scene:content', 'avatar'])).allowed
    ).toBe(false)
    destroyWorld(world)
  })

  it('temporal constraint enforces maxCountPerWindow from event log', () => {
    const world = mkWorld()
    const scene = createNamedEntity(world, 'scene:temp')
    addConstraint(world, scene, 'temporal', { appliesTo: ['Health-gov'], maxCountPerWindow: 2, windowMs: 10_000 })
    setUID(world, createEntity(world), 'avatar', { parent: scene })
    for (let i = 0; i < 2; i++) {
      world.eventLog.push({
        entityPath: ['scene:temp', 'avatar'],
        predicate: 'Health-gov',
        value: { current: i },
        op: 'set',
        author: 'did:test:alice',
        timestamp: 1_000_000 + i
      })
    }
    world.clock = { now: () => 1_000_005 } as typeof world.clock
    const result = validateEvent(world, mkEvent('Health-gov', { current: 9 }, ['scene:temp', 'avatar']))
    expect(result.allowed).toBe(false)
    expect(result.violations[0].kind).toBe('temporal')
    destroyWorld(world)
  })

  it('emits governance.accept / governance.reject trace events', () => {
    const world = mkWorld()
    const scene = createNamedEntity(world, 'scene:trace')
    addConstraint(world, scene, 'credential', { requiredCredential: 'x', operations: ['modify'] })
    setUID(world, createEntity(world), 'avatar', { parent: scene })
    const ev = mkEvent('Health-gov', { current: 1 }, ['scene:trace', 'avatar'])
    validateEvent(world, ev, { hasCredential: () => true })
    expect(world.trace.byKind('governance.accept')).toHaveLength(1)
    validateEvent(world, ev, { hasCredential: () => false })
    expect(world.trace.byKind('governance.reject')).toHaveLength(1)
    destroyWorld(world)
  })

  it('world-wide constraint via a top-level entity scope', () => {
    const world = mkWorld()
    const worldEntity = createNamedEntity(world, 'world-root')
    addConstraint(world, worldEntity, 'credential', { requiredCredential: 'root', operations: ['spawn'] })
    setUID(world, createEntity(world), 'thing', { parent: worldEntity })
    const ev: AuthoredEvent = {
      entityPath: ['world-root', 'thing'],
      predicate: 'X',
      value: null,
      op: 'spawn',
      author: 'did:test:any',
      timestamp: 0
    }
    const result = validateEvent(world, ev, { hasCredential: () => false })
    expect(result.allowed).toBe(false)
    destroyWorld(world)
  })
})
