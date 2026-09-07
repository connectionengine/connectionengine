import { describe, expect, it } from 'vitest'
import { Schema } from '../schema'
import { defineComponent, getComponent, hasComponent, setComponent } from '../ecs/component'
import { defineRelation, addRelation, getRelationTargets } from '../ecs/relation'
import { createAnonAgent, createWorld, destroyWorld, type Entity, type World } from '../ecs/world'
import { createEngine } from '../ecs/engine'
import { getEntityByUID, setUID } from '../ecs/entity'
import { createEntity } from '../ecs/entity'
import { applySnapshot, createSnapshot } from './snapshot'
import { ensureDefaultNetwork } from './network'
import { AuthoritativeFor, getAuthority } from './authority'
import { createPeer, createUser } from './peer'
import { spawnPrefab } from './prefab'

const named = (world: World, uid: string, parent?: Entity): Entity => {
  const e = createEntity(world)
  setUID(world, e, uid, parent !== undefined ? { parent } : undefined)
  return e
}

const Health = defineComponent({
  id: 'Health-snap',
  schema: Schema.Object({ current: Schema.Number({ default: 100 }), max: Schema.Number({ default: 100 }) })
})
const Transform = defineComponent({
  id: 'Transform-snap',
  schema: Schema.Object({ position: Schema.Vec3() })
})
const ChildOf = defineRelation({ name: 'ChildOf-snap', exclusive: true })

describe('Snapshot', () => {
  it('createSnapshot captures named entities + components + relations', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const scene = named(world, 'scene:snap')
    const a = createEntity(world)
    setUID(world, a, 'a', { parent: scene })
    setComponent(world, a, Health, { current: 75 })
    setComponent(world, a, Transform, { position: [1, 2, 3] })
    const b = createEntity(world)
    setUID(world, b, 'b', { parent: scene })
    addRelation(world, b, ChildOf, a)

    const snap = createSnapshot(world)
    expect(snap.metadata.entityCount).toBe(3) // scene + a + b
    expect(snap.metadata.components).toContain('Health-snap')
    expect(snap.entities.find((e) => e.path.join('/') === 'scene:snap/a')?.components['Health-snap']).toEqual({
      current: 75,
      max: 100
    })
    const bEnt = snap.entities.find((e) => e.path.join('/') === 'scene:snap/b')
    expect(bEnt?.relations['ChildOf-snap']).toEqual([['scene:snap', 'a']])
    destroyWorld(world)
  })

  it('applySnapshot to fresh world rebuilds equivalent state', () => {
    const source = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const scene = named(source, 'scene:snap2')
    const a = createEntity(source)
    setUID(source, a, 'a', { parent: scene })
    setComponent(source, a, Health, { current: 42 })
    setComponent(source, a, Transform, { position: [5, 6, 7] })

    const snap = createSnapshot(source)

    const target = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    applySnapshot(target, snap)

    const tScene = getEntityByUID(target, target.worldRoot, 'scene:snap2')
    expect(tScene).toBeDefined()
    const tA = getEntityByUID(target, tScene!, 'a')
    expect(tA).toBeDefined()
    expect(getComponent(target, tA!, Health)).toEqual({ current: 42, max: 100 })
    const tT = getComponent(target, tA!, Transform)
    expect(tT?.position.x).toBeCloseTo(5)
    expect(tT?.position.y).toBeCloseTo(6)
    expect(tT?.position.z).toBeCloseTo(7)
    destroyWorld(source)
    destroyWorld(target)
  })

  it('snapshot round-trip preserves relations', () => {
    const source = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const scene = named(source, 'scene:rel')
    const a = createEntity(source)
    setUID(source, a, 'a', { parent: scene })
    const b = createEntity(source)
    setUID(source, b, 'b', { parent: scene })
    addRelation(source, b, ChildOf, a)
    const snap = createSnapshot(source)
    const target = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    applySnapshot(target, snap)
    const tScene = getEntityByUID(target, target.worldRoot, 'scene:rel')!
    const tA = getEntityByUID(target, tScene, 'a')!
    const tB = getEntityByUID(target, tScene, 'b')!
    expect(getRelationTargets(target, tB, ChildOf)).toEqual([tA])
    destroyWorld(source)
    destroyWorld(target)
  })

  it('filter restricts captured components', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const e = named(world, 'x')
    setComponent(world, e, Health)
    setComponent(world, e, Transform, { position: [0, 0, 0] })
    const snap = createSnapshot(world, { filter: ['Health-snap'] })
    expect(snap.entities[0].components).toHaveProperty('Health-snap')
    expect(snap.entities[0].components).not.toHaveProperty('Transform-snap')
    destroyWorld(world)
  })

  it('replace mode clears prior named entities', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const a = named(world, 'a')
    setComponent(world, a, Health, { current: 1 })
    const snap = createSnapshot(world)
    setComponent(world, a, Health, { current: 999 })
    expect(getComponent(world, a, Health)).toEqual({ current: 999, max: 100 })
    applySnapshot(world, snap, { replace: true })
    const restored = getEntityByUID(world, world.worldRoot, 'a')!
    expect(hasComponent(world, restored, Health)).toBe(true)
    expect(getComponent(world, restored, Health)).toEqual({ current: 1, max: 100 })
    destroyWorld(world)
  })
})

describe('applySnapshot — governance', () => {
  /**
   * A snapshot arriving over the wire carries the same authority as any other
   * write from that peer — no more. Supplying `from` runs each component and
   * relation through the gates an authored event would face, so the bootstrap
   * path can't be used to smuggle in state the authored path would refuse.
   */
  it('skips writes the network gate refuses, keeping the rest', () => {
    const source = createWorld({ engine: createEngine(), agent: createAnonAgent('gate-src') })
    const target = createWorld({ engine: createEngine(), agent: createAnonAgent('gate-tgt') })

    const e = named(source, 'thing')
    setComponent(source, e, Health, { current: 42 })
    setComponent(source, e, Transform, { position: [1, 2, 3] })

    const network = ensureDefaultNetwork(target)
    network.validateAuthored = (event) => event.predicate !== Health.$id

    applySnapshot(target, createSnapshot(source), { from: { author: 'did:test:peer', network } })

    const te = getEntityByUID(target, target.worldRoot, 'thing')!
    expect(hasComponent(target, te, Health)).toBe(false)
    expect(hasComponent(target, te, Transform)).toBe(true)

    destroyWorld(source)
    destroyWorld(target)
  })

  it('the gate sees the sending peer as author', () => {
    const source = createWorld({ engine: createEngine(), agent: createAnonAgent('author-src') })
    const target = createWorld({ engine: createEngine(), agent: createAnonAgent('author-tgt') })
    setComponent(source, named(source, 'thing'), Health, { current: 1 })

    const authors: string[] = []
    const network = ensureDefaultNetwork(target)
    network.validateAuthored = (event) => {
      authors.push(event.author)
      return true
    }
    applySnapshot(target, createSnapshot(source), { from: { author: 'did:test:sender', network } })

    expect(authors.length).toBeGreaterThan(0)
    expect(new Set(authors)).toEqual(new Set(['did:test:sender']))

    destroyWorld(source)
    destroyWorld(target)
  })

  it('cannot hand the sender authority it has no standing to take', () => {
    const host = createWorld({ engine: createEngine(), agent: createAnonAgent('auth-host') })
    const hostUser = createUser(host, { did: 'did:test:host', uid: 'user:host', asLocal: true })
    const hostPeer = createPeer(host, { user: hostUser, peerId: 'host-p', uid: 'peer:host-p', asLocal: true })
    const thing = spawnPrefab(host, 'thing')
    expect(getAuthority(host, thing)).toBe(hostPeer)

    // A rogue peer known locally, and a forged snapshot claiming authority.
    const rogueUser = createUser(host, { did: 'did:test:rogue', uid: 'user:rogue' })
    createPeer(host, { user: rogueUser, peerId: 'rogue-p', uid: 'peer:rogue-p' })
    const forged = createSnapshot(host)
    for (const ent of forged.entities) {
      if (ent.path.join('/') === 'thing') ent.relations[AuthoritativeFor.name] = [['user:rogue', 'peer:rogue-p']]
    }

    applySnapshot(host, forged, { from: { author: 'did:test:rogue' } })

    // The standing check runs even with no network gate installed.
    expect(getAuthority(host, thing)).toBe(hostPeer)
    destroyWorld(host)
  })

  it('a local apply stays ungated — persistence and rollback are trusted', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent('trusted') })
    setComponent(world, named(world, 'thing'), Health, { current: 7 })
    const snap = createSnapshot(world)

    const restored = createWorld({ engine: createEngine(), agent: createAnonAgent('restored') })
    const network = ensureDefaultNetwork(restored)
    network.validateAuthored = () => false // would reject everything, if consulted
    applySnapshot(restored, snap)

    const re = getEntityByUID(restored, restored.worldRoot, 'thing')!
    expect(getComponent(restored, re, Health)?.current).toBe(7)

    destroyWorld(world)
    destroyWorld(restored)
  })
})
