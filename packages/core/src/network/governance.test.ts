/**
 * Governance holds no policy of its own, so these tests register a kind the way
 * a consumer would and check the mechanism around it: constraints resolve up
 * the scope chain, and `validateEvent` runs whatever the registry holds.
 */

import { describe, expect, it } from 'vitest'
import { Schema } from '../schema'
import { createEngine } from '../ecs/engine'
import { createAnonAgent, createWorld, destroyWorld, type AuthoredEvent, type Entity, type World } from '../ecs/world'
import { createEntity, setUID } from '../ecs/entity'
import { defineComponent } from '../ecs/component'
import { addConstraint, registerConstraintKind, resolveConstraints, validateEvent } from './governance'

/** A kind that refuses a write when the value exceeds a configured maximum. */
const MaxValueConstraint = defineComponent({
  id: 'MaxValueConstraint',
  schema: Schema.Object({ predicate: Schema.String({ default: '' }), max: Schema.Number({ default: 0 }) })
})

registerConstraintKind({
  kind: 'max-value',
  component: MaxValueConstraint,
  validate({ event, data, violations }) {
    if (data.predicate !== event.predicate) return
    const current = (event.value as { current?: number } | null)?.current
    if (typeof current === 'number' && current > (data.max as number)) {
      violations.push({ kind: 'max-value', reason: `${current} exceeds ${data.max as number}` })
    }
  }
})

/** A kind that refuses everything, for ordering checks. */
const DenyAllConstraint = defineComponent({
  id: 'DenyAllConstraint',
  schema: Schema.Object({ note: Schema.String({ default: '' }) })
})

registerConstraintKind({
  kind: 'deny-all',
  component: DenyAllConstraint,
  validate({ violations }) {
    violations.push({ kind: 'deny-all', reason: 'denied' })
  }
})

const mkWorld = (): World => createWorld({ engine: createEngine(), agent: createAnonAgent('test') })

const named = (world: World, uid: string, parent?: Entity): Entity => {
  const e = createEntity(world)
  if (parent === undefined) setUID(world, e, uid)
  else setUID(world, e, uid, { parent })
  return e
}

const mkEvent = (predicate: string, value: unknown, path: string[]): AuthoredEvent => ({
  entityPath: path,
  predicate,
  value,
  op: 'set',
  author: 'did:test:alice',
  timestamp: 1_000_000,
  seq: 0
})

describe('resolveConstraints', () => {
  it('finds a constraint attached to the entity itself', () => {
    const world = mkWorld()
    const scene = named(world, 'scene:a')
    addConstraint(world, scene, 'max-value', { predicate: 'Health', max: 50 })
    const resolved = resolveConstraints(world, scene)
    expect(resolved).toHaveLength(1)
    expect(resolved[0].kind).toBe('max-value')
    expect(resolved[0].scope).toBe(scene)
    destroyWorld(world)
  })

  it('walks up the BelongsTo chain, most specific first', () => {
    const world = mkWorld()
    const root = named(world, 'root')
    const scene = named(world, 'scene:b', root)
    const avatar = named(world, 'avatar', scene)
    addConstraint(world, root, 'deny-all', { note: 'outer' })
    addConstraint(world, scene, 'max-value', { predicate: 'Health', max: 10 })
    expect(resolveConstraints(world, avatar).map((c) => c.kind)).toEqual(['max-value', 'deny-all'])
    destroyWorld(world)
  })
})

describe('validateEvent', () => {
  it('accepts when nothing guards the entity', () => {
    const world = mkWorld()
    named(world, 'scene:c')
    expect(validateEvent(world, mkEvent('Health', { current: 999 }, ['scene:c'])).allowed).toBe(true)
    destroyWorld(world)
  })

  it('refuses a write the registered kind rejects', () => {
    const world = mkWorld()
    const scene = named(world, 'scene:d')
    addConstraint(world, scene, 'max-value', { predicate: 'Health', max: 50 })
    named(world, 'avatar', scene)
    const result = validateEvent(world, mkEvent('Health', { current: 80 }, ['scene:d', 'avatar']))
    expect(result.allowed).toBe(false)
    expect(result.violations[0].kind).toBe('max-value')
    destroyWorld(world)
  })

  it('admits a write the same kind allows', () => {
    const world = mkWorld()
    const scene = named(world, 'scene:e')
    addConstraint(world, scene, 'max-value', { predicate: 'Health', max: 50 })
    named(world, 'avatar', scene)
    expect(validateEvent(world, mkEvent('Health', { current: 20 }, ['scene:e', 'avatar'])).allowed).toBe(true)
    destroyWorld(world)
  })

  it('ignores a predicate the constraint does not name', () => {
    const world = mkWorld()
    const scene = named(world, 'scene:f')
    addConstraint(world, scene, 'max-value', { predicate: 'Health', max: 1 })
    named(world, 'avatar', scene)
    expect(validateEvent(world, mkEvent('Mana', { current: 999 }, ['scene:f', 'avatar'])).allowed).toBe(true)
    destroyWorld(world)
  })

  it('gives the same verdict on two peers, since it reads only replicated state', () => {
    // The property the design depends on. A validator sees the event, the
    // constraint data, and the scope — never a local clock or oracle — so two
    // peers holding the same data cannot disagree.
    const build = (): World => {
      const world = mkWorld()
      const scene = named(world, 'scene:g')
      addConstraint(world, scene, 'max-value', { predicate: 'Health', max: 50 })
      named(world, 'avatar', scene)
      return world
    }
    const event = mkEvent('Health', { current: 80 }, ['scene:g', 'avatar'])
    const a = build()
    const b = build()
    expect(validateEvent(a, event).allowed).toBe(validateEvent(b, event).allowed)
    expect(validateEvent(a, event).allowed).toBe(false)
    destroyWorld(a)
    destroyWorld(b)
  })

  it('throws when the kind is not registered', () => {
    const world = mkWorld()
    const scene = named(world, 'scene:h')
    expect(() => addConstraint(world, scene, 'no-such-kind', {})).toThrow()
    destroyWorld(world)
  })
})
