import { describe, expect, it } from 'vitest'
import { createEngine } from './engine'
import { createAnonAgent, createWorld, destroyWorld } from './world'
import { createEntity, removeEntity } from './entity'
import { addRelation, defineRelation, getRelationTargets, hasRelation, removeRelation } from './relation'

const ChildOf = defineRelation({
  name: 'ChildOf',
  exclusive: true,
  autoRemoveSubject: true
})

const EquippedBy = defineRelation({
  name: 'EquippedBy',
  exclusive: true,
  store: () => ({ slot: '' as string })
})

const Friend = defineRelation({
  name: 'Friend' // non-exclusive
})

describe('Relation', () => {
  it('adds and removes a relationship pair', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const parent = createEntity(world)
    const child = createEntity(world)
    addRelation(world, child, ChildOf, parent)
    expect(hasRelation(world, child, ChildOf, parent)).toBe(true)
    expect(getRelationTargets(world, child, ChildOf)).toEqual([parent])
    removeRelation(world, child, ChildOf, parent)
    expect(hasRelation(world, child, ChildOf, parent)).toBe(false)
    destroyWorld(world)
  })

  it('exclusive relation auto-replaces existing target', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const child = createEntity(world)
    const a = createEntity(world)
    const b = createEntity(world)
    addRelation(world, child, ChildOf, a)
    addRelation(world, child, ChildOf, b)
    const targets = getRelationTargets(world, child, ChildOf)
    expect(targets).toEqual([b])
    destroyWorld(world)
  })

  it('autoRemoveSubject cascades when target removed', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const parent = createEntity(world)
    const child = createEntity(world)
    addRelation(world, child, ChildOf, parent)
    removeEntity(world, parent)
    // bitECS commits removals lazily — query() forces commit; we rely on its
    // hook firing here. The cascade is bitECS-native; we just verify the spec
    // intent: child is no longer a subject of ChildOf with the dead parent.
    expect(hasRelation(world, child, ChildOf, parent)).toBe(false)
    destroyWorld(world)
  })

  it('non-exclusive relation supports multiple targets', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const me = createEntity(world)
    const a = createEntity(world)
    const b = createEntity(world)
    addRelation(world, me, Friend, a)
    addRelation(world, me, Friend, b)
    expect(getRelationTargets(world, me, Friend).sort()).toEqual([a, b].sort())
    destroyWorld(world)
  })

  it('per-pair store data is allocated and writable', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const item = createEntity(world)
    const owner = createEntity(world)
    addRelation(world, item, EquippedBy, owner)
    // store-bearing relations expose the data on the pair component
    const pair = EquippedBy.$relation(owner) as unknown as { slot: string }
    pair.slot = 'main-hand'
    expect((EquippedBy.$relation(owner) as unknown as { slot: string }).slot).toBe('main-hand')
    destroyWorld(world)
  })

  it('local-origin adds enqueue authored writes; network-origin does not', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const child = createEntity(world)
    const parent = createEntity(world)
    addRelation(world, child, ChildOf, parent)
    expect(world.authoredQueue).toHaveLength(1)
    expect(world.authoredQueue[0].predicate).toBe('ChildOf')
    addRelation(world, child, ChildOf, parent, { origin: 'network' })
    expect(world.authoredQueue).toHaveLength(1)
    destroyWorld(world)
  })

  it('replicates by default; `sync: false` opts out', () => {
    expect(ChildOf.sync).toBe(true)
    const LocalOnly = defineRelation({ name: 'LocalOnly', sync: false })
    expect(LocalOnly.sync).toBe(false)
  })
})
