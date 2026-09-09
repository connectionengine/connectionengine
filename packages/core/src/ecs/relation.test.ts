import { describe, expect, it } from 'vitest'
import { createEngine } from './engine'
import { createAnonAgent, createWorld, destroyWorld } from './world'
import { createEntity, removeEntity } from './entity'
import {
  addRelation,
  defineRelation,
  getRelationByName,
  getRelationTargets,
  hasRelation,
  indexedRelations,
  removeRelation
} from './relation'

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
    // hook firing here. The cascade is bitECS-native, so this only verifies the spec
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

// `index: true` is the whole declaration. The map type never appears at a call
// site, because a relation index always maps one entity onto another.
const Tracked = defineRelation({
  name: 'TrackedBy',
  exclusive: true,
  index: true
})

describe('defineRelation index accessors', () => {
  const setup = () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent('idx') })
    return { world, a: createEntity(world), b: createEntity(world), c: createEntity(world) }
  }

  it('supplies get, set and indexFor, and omits them without the option', () => {
    const { world, a, b } = setup()
    Tracked.set(world, a, b)
    expect(Tracked.get(world, a)).toBe(b)
    expect(hasRelation(world, a, Tracked, b)).toBe(true)
    expect(Tracked.indexFor(world.engine).get(a)).toBe(b)
    // A relation that declared no index carries no accessors to call.
    expect('get' in Friend).toBe(false)
    expect('indexFor' in Friend).toBe(false)
    destroyWorld(world)
  })

  it('follows an exclusive replacement', () => {
    const { world, a, b, c } = setup()
    Tracked.set(world, a, b)
    Tracked.set(world, a, c)
    expect(Tracked.get(world, a)).toBe(c)
    expect(getRelationTargets(world, a, Tracked)).toEqual([c])
    destroyWorld(world)
  })

  it('ignores the removal of a target it no longer names', () => {
    const { world, a, b, c } = setup()
    Tracked.set(world, a, b)
    Tracked.set(world, a, c)
    removeRelation(world, a, Tracked, b)
    expect(Tracked.get(world, a)).toBe(c)
    removeRelation(world, a, Tracked, c)
    expect(Tracked.get(world, a)).toBeUndefined()
    destroyWorld(world)
  })

  it('keeps two engines apart', () => {
    const { world, a, b } = setup()
    const other = createWorld({ engine: createEngine(), agent: createAnonAgent('idx2') })
    Tracked.set(world, a, b)
    // Entity ids repeat across engines, so the index must key on the engine.
    expect(Tracked.get(other, a)).toBeUndefined()
    destroyWorld(other)
    destroyWorld(world)
  })

  it('drops the entry when the subject goes', () => {
    const { world, a, b } = setup()
    Tracked.set(world, a, b)
    removeEntity(world, a)
    expect(Tracked.indexFor(world.engine).has(a)).toBe(false)
    destroyWorld(world)
  })
})

describe('index requires exclusive', () => {
  it('rejects the pairing at compile time', () => {
    // An index maps one subject onto one target. A non-exclusive relation holds
    // many, so the pair produces a map that disagrees with its own relation:
    // the second add overwrites the first entry, and removing whichever target
    // the entry names clears it while the others still stand.
    //
    // Both directives below fail the build if the constraint ever loosens,
    // because an unused `@ts-expect-error` is itself an error.

    // @ts-expect-error index requires exclusive: true — omitted here
    const noExclusive = () => defineRelation({ name: 'IdxNoExclusive', index: true })

    // @ts-expect-error index requires exclusive: true — explicitly false here
    const falseExclusive = () => defineRelation({ name: 'IdxFalseExclusive', exclusive: false, index: true })

    // The runtime guard covers a caller that arrived without types.
    expect(noExclusive).toThrow(/index requires exclusive/)
    expect(falseExclusive).toThrow(/index requires exclusive/)
  })

  it('registers nothing for a rejected definition', () => {
    // The guard runs before the registry write, so a throw leaves no
    // half-built relation behind for `allRelations` or `indexedRelations`.
    expect(getRelationByName('IdxNoExclusive')).toBeUndefined()
    expect(indexedRelations().some((r) => r.name === 'IdxNoExclusive')).toBe(false)
  })
})
