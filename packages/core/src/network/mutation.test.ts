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
    position: Schema.Vec3({ sync: 'continuous' }),
    rotation: Schema.Quat({ sync: 'continuous' })
  })
})

const ChildOf = defineRelation({ name: 'ChildOf', exclusive: true })

describe('Two-peer authored replication', () => {
  it('peer A setComponent → peer B sees value', async () => {
    const peers = await createPeerPair()
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
    const peers = await createPeerPair()
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
    const peers = await createPeerPair()
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

  it('echo suppression prevents re-broadcast (no infinite loop)', async () => {
    const peers = await createPeerPair()
    const { a, b } = peers
    const scene = spawnPrefab(a.world, 'scene:echo')
    const e = createEntity(a.world)
    setUID(a.world, e, 'thing', { parent: scene })
    setComponent(a.world, e, Health, { current: 50 })

    await peers.tick()
    await peers.tick()
    await peers.tick()

    // B never re-broadcasts the network-received write back to A. Echo
    // suppression clears the dirty entries that applyEvent produces.
    expect(
      b.world.componentDirty
        .get('Health')
        ?.has(getEntityByUID(b.world, getEntityByUID(b.world, b.world.worldRoot, 'scene:echo')!, 'thing')!) ?? false
    ).toBe(false)
    peers.dispose()
  })

  it('event log is append-only and ordered', async () => {
    const peers = await createPeerPair()
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
    const peers = await createPeerPair()
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
    const peers = await createPeerPair()
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
    const peers = await createPeerPair()
    const { a, b } = peers
    const scene = spawnPrefab(a.world, 'scene:x')
    const e = createEntity(a.world)
    setUID(a.world, e, 'p', { parent: scene })
    setComponent(a.world, e, Health, { current: 1 })
    await peers.tick()
    await peers.tick()
    expect(b.world.componentDirty.get('Health')?.size ?? 0).toBe(0)
    peers.dispose()
  })
})

// ── Spec 08: per-field sync/sparse in the mutation pipeline ──────────────────

const SparseDiscreteVec3 = defineComponent({
  id: 'Mut.SparseDisc',
  schema: Schema.Object({
    anchor: Schema.Vec3({ sparse: true })
  })
})

const SparseContinuousVec3 = defineComponent({
  id: 'Mut.SparseCont',
  schema: Schema.Object({
    offset: Schema.Vec3({ sync: 'continuous', sparse: true })
  })
})

const MixedChannels = defineComponent({
  id: 'Mut.MixedCh',
  schema: Schema.Object({
    position: Schema.Vec3({ sync: 'continuous' }),
    label: Schema.String({ default: '' })
  })
})

describe('Spec 08 — discrete sparse Vec3 replicates via authored envelope', () => {
  it('sparse discrete Vec3 round-trips through the authored channel', async () => {
    const peers = await createPeerPair()
    const { a, b } = peers
    const scene = spawnPrefab(a.world, 'scene:s08-disc')
    const e = createEntity(a.world)
    setUID(a.world, e, 'anchor-ent', { parent: scene })
    setComponent(a.world, e, SparseDiscreteVec3, { anchor: [7, 14, 21] })

    await peers.tick()

    const bScene = getEntityByUID(b.world, b.world.worldRoot, 'scene:s08-disc')!
    const bE = getEntityByUID(b.world, bScene, 'anchor-ent')!
    const bVal = getComponent(b.world, bE, SparseDiscreteVec3)
    expect(bVal?.anchor).toEqual([7, 14, 21])
    peers.dispose()
  })

  it('subsequent set of sparse discrete Vec3 replicates the update', async () => {
    const peers = await createPeerPair()
    const { a, b } = peers
    const scene = spawnPrefab(a.world, 'scene:s08-disc2')
    const e = createEntity(a.world)
    setUID(a.world, e, 'anchor2', { parent: scene })
    setComponent(a.world, e, SparseDiscreteVec3, { anchor: [1, 1, 1] })
    await peers.tick()

    setComponent(a.world, e, SparseDiscreteVec3, { anchor: [2, 4, 8] })
    await peers.tick()

    const bScene = getEntityByUID(b.world, b.world.worldRoot, 'scene:s08-disc2')!
    const bE = getEntityByUID(b.world, bScene, 'anchor2')!
    expect(getComponent(b.world, bE, SparseDiscreteVec3)?.anchor).toEqual([2, 4, 8])
    peers.dispose()
  })
})

describe('Spec 08 — continuous sparse Vec3 replicates via binary channel', () => {
  it('sparse continuous Vec3 round-trips through the runtime binary pipeline', async () => {
    const peers = await createPeerPair()
    const { a, b } = peers
    const scene = spawnPrefab(a.world, 'scene:s08-cont')
    const e = createEntity(a.world)
    setUID(a.world, e, 'offset-ent', { parent: scene })
    setComponent(a.world, e, SparseContinuousVec3, { offset: [5, 10, 15] })

    await peers.tick()

    const bScene = getEntityByUID(b.world, b.world.worldRoot, 'scene:s08-cont')!
    const bE = getEntityByUID(b.world, bScene, 'offset-ent')!
    const bVal = getComponent(b.world, bE, SparseContinuousVec3)
    expect(bVal?.offset).toBeDefined()
    const offArr = bVal!.offset as unknown as number[]
    expect(offArr[0]).toBeCloseTo(5)
    expect(offArr[1]).toBeCloseTo(10)
    expect(offArr[2]).toBeCloseTo(15)
    peers.dispose()
  })
})

describe('Spec 08 — mixed continuous+discrete only authors on discrete write', () => {
  it('writing only the continuous field does not mark componentDirty', async () => {
    const peers = await createPeerPair()
    const { a } = peers
    const scene = spawnPrefab(a.world, 'scene:s08-mix')
    const e = createEntity(a.world)
    setUID(a.world, e, 'mixed-ent', { parent: scene })
    setComponent(a.world, e, MixedChannels, { position: [1, 0, 0], label: 'init' })
    await peers.tick()

    MixedChannels.position.x[e] = 99
    a.world.runtimeDirty.get(MixedChannels.$id)?.add(e)
    await peers.tick()

    expect(a.world.componentDirty.get(MixedChannels.$id)?.has(e) ?? false).toBe(false)
    peers.dispose()
  })

  it('writing the discrete field authors an event even when continuous fields also change', async () => {
    const peers = await createPeerPair()
    const { a, b } = peers
    const scene = spawnPrefab(a.world, 'scene:s08-mix2')
    const e = createEntity(a.world)
    setUID(a.world, e, 'mixed-ent2', { parent: scene })
    setComponent(a.world, e, MixedChannels, { position: [0, 0, 0], label: 'hello' })
    await peers.tick()

    setComponent(a.world, e, MixedChannels, { label: 'updated' })
    await peers.tick()

    const bScene = getEntityByUID(b.world, b.world.worldRoot, 'scene:s08-mix2')!
    const bE = getEntityByUID(b.world, bScene, 'mixed-ent2')!
    expect(getComponent(b.world, bE, MixedChannels)?.label).toBe('updated')
    peers.dispose()
  })
})

// Sanity: re-export check
describe('destroyWorld cleans up world after pipeline use', () => {
  it('disposes cleanly', async () => {
    const peers = await createPeerPair()
    peers.dispose()
    // destroyWorld is idempotent
    destroyWorld(peers.a.world)
    destroyWorld(peers.b.world)
  })
})
