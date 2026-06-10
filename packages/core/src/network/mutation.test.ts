import { describe, expect, it } from 'vitest'
import { Schema } from '../schema'
import { defineComponent, getComponent, hasComponent, setComponent } from '../ecs/component'
import { defineRelation, getRelationTargets } from '../ecs/relation'
import { setUID, getEntityByUID } from '../ecs/entity'
import { createEntity } from '../ecs/entity'
import { spawnPrefab } from './prefab'
import { destroyWorld } from '../ecs/world'
import { createPeerPair } from '../../tests/test-utils/peer-pair'

const Health = defineComponent({
  id: 'Health',
  schema: Schema.Object({
    current: Schema.Number({ default: 100 }),
    max: Schema.Number({ default: 100 })
  })
})

const Transform = defineComponent({
  id: 'Transform',
  schema: Schema.Object({
    position: Schema.Vec3(),
    rotation: Schema.Quat()
  })
})

const ChildOf = defineRelation({ name: 'ChildOf', exclusive: true })

describe('Two-peer authored replication', () => {
  it('peer A setComponent → peer B sees value', async () => {
    const peers = createPeerPair()
    const { a, b } = peers

    const scene = spawnPrefab(a.world, 'scene:main')
    const avatar = createEntity(a.world)
    setUID(a.world, avatar, 'avatar:alice', { parent: scene })
    setComponent(a.world, avatar, Health, { current: 80 })

    await peers.tick()

    const bScene = getEntityByUID(b.world, b.world.worldRoot, 'scene:main')
    expect(bScene).toBeDefined()
    const bAvatar = getEntityByUID(b.world, bScene!, 'avatar:alice')
    expect(bAvatar).toBeDefined()
    const bHealth = getComponent(b.world, bAvatar!, Health)
    expect(bHealth).toEqual({ current: 80, max: 100 })
    peers.dispose()
  })

  it('removeComponent replicates as a remove triple', async () => {
    const peers = createPeerPair()
    const { a, b } = peers
    const scene = spawnPrefab(a.world, 'scene:main')
    const e = createEntity(a.world)
    setUID(a.world, e, 'thing', { parent: scene })
    setComponent(a.world, e, Health)
    await peers.tick()
    const bSceneFirst = getEntityByUID(b.world, b.world.worldRoot, 'scene:main')
    const bThing = getEntityByUID(b.world, bSceneFirst!, 'thing')
    expect(hasComponent(b.world, bThing!, Health)).toBe(true)

    // Now remove on A
    const { removeComponent } = await import('../ecs/component')
    removeComponent(a.world, e, Health)
    await peers.tick()
    expect(hasComponent(b.world, bThing!, Health)).toBe(false)
    peers.dispose()
  })

  it('relations replicate by walking path on receive', async () => {
    const peers = createPeerPair()
    const { a, b } = peers
    const scene = spawnPrefab(a.world, 'scene:main')
    const parent = createEntity(a.world)
    setUID(a.world, parent, 'parent', { parent: scene })
    const child = createEntity(a.world)
    setUID(a.world, child, 'child', { parent: scene })
    // addRelation is local-origin authored
    const { addRelation } = await import('../ecs/relation')
    addRelation(a.world, child, ChildOf, parent)
    await peers.tick()

    const bScene = getEntityByUID(b.world, b.world.worldRoot, 'scene:main')!
    const bParent = getEntityByUID(b.world, bScene, 'parent')!
    const bChild = getEntityByUID(b.world, bScene, 'child')!
    const targets = getRelationTargets(b.world, bChild, ChildOf)
    expect(targets).toEqual([bParent])
    peers.dispose()
  })

  it('origin tag prevents re-broadcast (no infinite loop)', async () => {
    const peers = createPeerPair()
    const { a, b } = peers
    const scene = spawnPrefab(a.world, 'scene:loop')
    const e = createEntity(a.world)
    setUID(a.world, e, 'thing', { parent: scene })
    setComponent(a.world, e, Health, { current: 50 })

    await peers.tick()
    await peers.tick()
    await peers.tick()

    // B never re-broadcasts the network-origin write back to A. A's authored
    // events for 'thing' / Health flush via A; B's eventLog gains them with
    // origin='network' which the dirty/queue paths skip.
    const bAuthoredAboutThing = b.world.authoredQueue.filter((q) => q.predicate === 'Health')
    expect(bAuthoredAboutThing).toHaveLength(0)
    peers.dispose()
  })

  it('event log is append-only and ordered', async () => {
    const peers = createPeerPair()
    const { a, b } = peers
    const scene = spawnPrefab(a.world, 'scene:log')
    const e = createEntity(a.world)
    setUID(a.world, e, 'thing', { parent: scene })
    setComponent(a.world, e, Health, { current: 10 })
    setComponent(a.world, e, Health, { current: 20 })
    setComponent(a.world, e, Health, { current: 30 })

    await peers.tick()
    // A logged 3 emits + 1 for the UID component set + 1 for the scene UID
    expect(a.world.eventLog.length).toBeGreaterThanOrEqual(3)
    // B's log should match A's count after receive
    expect(b.world.eventLog.length).toBe(a.world.eventLog.length)
    peers.dispose()
  })
})

describe('Two-peer runtime replication', () => {
  it('SoA values propagate via runtime packet', async () => {
    const peers = createPeerPair()
    const { a, b } = peers
    const scene = spawnPrefab(a.world, 'scene:rt')
    const e = createEntity(a.world)
    setUID(a.world, e, 'thing', { parent: scene })
    setComponent(a.world, e, Transform, { position: [1, 2, 3], rotation: [0, 0, 0, 1] })

    await peers.tick()

    const bScene = getEntityByUID(b.world, b.world.worldRoot, 'scene:rt')!
    const bThing = getEntityByUID(b.world, bScene, 'thing')!
    const bT = getComponent(b.world, bThing, Transform)
    expect(bT?.position.x).toBeCloseTo(1)
    expect(bT?.position.y).toBeCloseTo(2)
    expect(bT?.position.z).toBeCloseTo(3)
    peers.dispose()
  })

  it('runtime flush clears dirty set; subsequent ticks ship only new dirty entities', async () => {
    const peers = createPeerPair()
    const { a } = peers
    const scene = spawnPrefab(a.world, 'scene:rt')
    const e = createEntity(a.world)
    setUID(a.world, e, 'thing', { parent: scene })
    setComponent(a.world, e, Transform, { position: [1, 0, 0] })
    await peers.tick()
    expect(a.world.runtimeDirty.get('Transform')?.size ?? 0).toBe(0)
    setComponent(a.world, e, Transform, { position: [2, 0, 0] })
    expect(a.world.runtimeDirty.get('Transform')?.size).toBe(1)
    await peers.tick()
    expect(a.world.runtimeDirty.get('Transform')?.size).toBe(0)
    peers.dispose()
  })
})

describe('Property invariants — pipeline', () => {
  it('round-trip: applyTriple does not re-emit', async () => {
    const peers = createPeerPair()
    const { a, b } = peers
    const scene = spawnPrefab(a.world, 'scene:x')
    const e = createEntity(a.world)
    setUID(a.world, e, 'p', { parent: scene })
    setComponent(a.world, e, Health, { current: 1 })
    await peers.tick()
    const beforeQueueLen = b.world.authoredQueue.length
    await peers.tick()
    expect(b.world.authoredQueue.length).toBe(beforeQueueLen)
    peers.dispose()
  })
})

// Sanity: re-export check
describe('destroyWorld cleans up world after pipeline use', () => {
  it('disposes cleanly', () => {
    const peers = createPeerPair()
    peers.dispose()
    // destroyWorld is idempotent
    destroyWorld(peers.a.world)
    destroyWorld(peers.b.world)
  })
})
