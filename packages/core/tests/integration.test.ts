/**
 * Cross-domain integration scenarios — core only.
 *
 * These wire together identity, components, relations, mutation pipeline,
 * transport, authority, governance, and snapshot in two-peer (and three-peer)
 * topologies, then assert convergence and policy enforcement under realistic
 * flows.
 *
 * Core uses anonymous agents + an unsigned in-memory transport.
 * Signing-aware scenarios live in @connectionengine/local's test suite.
 */

import { describe, expect, it } from 'vitest'
import { Schema } from '../src/schema'
import { defineComponent, getComponent, setComponent } from '../src/ecs/component'
import { createEntity } from '../src/ecs/entity'
import { getEntityByUID, setUID } from '../src/ecs/entity'
import { createPeer, createUser } from '../src/network/peer'
import { getAuthority, grantAuthority, setOwner, transferAuthority } from '../src/network/authority'
import { spawnPrefab } from '../src/network/prefab'
import { addConstraint, registerConstraintKind, validateEvent } from '../src/network/governance'
import { applySnapshot, createSnapshot } from '../src/network/snapshot'
import { connectInMemory } from '../src/testing/connect-memory'
import { flushAsync } from '../src/network/transport'
import { createPeerMesh, createPeerPair } from './test-utils/peer-pair'
import { createEngine } from '../src/ecs/engine'
import { createAnonAgent, createWorld, destroyWorld } from '../src/ecs/world'

// Components used across scenarios — global definitions, per-world stores.
const Health = defineComponent({
  id: 'Int.Health',
  schema: Schema.Object({
    current: Schema.Number({ default: 100 }),
    max: Schema.Number({ default: 100 })
  })
})

const Transform = defineComponent({
  id: 'Int.Transform',
  schema: Schema.Object({
    position: Schema.Vec3(),
    rotation: Schema.Quat()
  })
})

const Label = defineComponent({
  id: 'Int.Label',
  schema: Schema.Object({ text: Schema.String({ default: '' }) })
})

// Core defines no constraint kinds, so a governance scenario brings its own.
const MaxHealthConstraint = defineComponent({
  id: 'Int.MaxHealthConstraint',
  schema: Schema.Object({ max: Schema.Number({ default: 0 }) })
})

registerConstraintKind({
  kind: 'max-health',
  component: MaxHealthConstraint,
  validate({ event, data, violations }) {
    if (event.predicate !== Health.$id) return
    const current = (event.value as { current?: number } | null)?.current
    if (typeof current === 'number' && current > (data.max as number)) {
      violations.push({ kind: 'max-health', reason: 'over max' })
    }
  }
})

describe('Scenario: spawn → replicate → mutate → converge', () => {
  it('two peers see identical world state after a sequence of operations', async () => {
    const peers = createPeerPair({ names: ['alice', 'bob'] })
    const { a, b } = peers

    const scene = spawnPrefab(a.world, 'scene:arena')
    for (const name of ['ava', 'bee', 'cee']) {
      const e = createEntity(a.world)
      setUID(a.world, e, name, { parent: scene })
      setComponent(a.world, e, Health, { current: 100 })
      setComponent(a.world, e, Transform, { position: [0, 0, 0], rotation: [0, 0, 0, 1] })
      setComponent(a.world, e, Label, { text: name })
    }
    await peers.tick()

    const bScene = getEntityByUID(b.world, b.world.worldRoot, 'scene:arena')!
    for (const name of ['ava', 'bee', 'cee']) {
      const e = getEntityByUID(b.world, bScene, name)!
      expect(e).toBeDefined()
      expect(getComponent(b.world, e, Label)).toEqual({ text: name })
      expect(getComponent(b.world, e, Health)).toEqual({ current: 100, max: 100 })
    }

    const ava = getEntityByUID(a.world, scene, 'ava')!
    setComponent(a.world, ava, Health, { current: 25 })
    await peers.tick()

    const bAva = getEntityByUID(b.world, bScene, 'ava')!
    expect(getComponent(b.world, bAva, Health)).toEqual({ current: 25, max: 100 })

    const bBee = getEntityByUID(b.world, bScene, 'bee')!
    setComponent(b.world, bBee, Transform, { position: [5, 0, 5], rotation: [0, 0, 0, 1] })
    await peers.tick()

    const aBee = getEntityByUID(a.world, scene, 'bee')!
    const aBeeT = getComponent(a.world, aBee, Transform)
    expect(aBeeT?.position.x).toBeCloseTo(5)
    expect(aBeeT?.position.z).toBeCloseTo(5)

    peers.dispose()
  })
})

describe('Scenario: governance rejects unauthorised mutations', () => {
  it('a write the gate refuses never lands on the other peer', async () => {
    const peers = createPeerPair({
      transport: { onValidateAuthored: (world, _network, event) => validateEvent(world, event).allowed }
    })
    const { a, b } = peers
    const scene = spawnPrefab(a.world, 'scene:guarded')
    addConstraint(a.world, scene, 'max-health', { max: 100 })
    const ava = createEntity(a.world)
    setUID(a.world, ava, 'ava', { parent: scene })
    setComponent(a.world, ava, Health, { current: 50 })
    await peers.tick()

    // The constraint replicated with the scene, so Bob's peer holds it too and
    // refuses the write locally as well as on arrival at Alice.
    const bScene = getEntityByUID(b.world, b.world.worldRoot, 'scene:guarded')!
    const bAva = getEntityByUID(b.world, bScene, 'ava')!
    expect(getComponent(b.world, bAva, Health)?.current).toBe(50)

    setComponent(b.world, bAva, Health, { current: 9999 })
    await peers.tick()
    expect(getComponent(a.world, ava, Health)?.current).toBe(50)
    peers.dispose()
  })
})

describe('Scenario: authority transfer between peers', () => {
  it('owner-user grants authority to one of their peers', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent('owner') })
    const user = createUser(world, { did: 'did:test:owner' })
    const desktopPeer = createPeer(world, { user, peerId: 'desktop', asLocal: true })
    const phonePeer = createPeer(world, { user, peerId: 'phone' })

    const vehicle = createEntity(world)
    setUID(world, vehicle, 'vehicle:1', { parent: spawnPrefab(world, 'scene:roads') })
    setOwner(world, vehicle, user)
    grantAuthority(world, vehicle, desktopPeer)

    transferAuthority(world, vehicle, phonePeer)
    expect(getAuthority(world, vehicle)).toBe(phonePeer)

    destroyWorld(world)
  })
})

describe('Scenario: snapshot bootstraps a late-joining peer', () => {
  it('peer C joins after A+B have built state; snapshot brings C in sync', async () => {
    const peers = createPeerPair({ names: ['alice', 'bob'] })
    const { a, b } = peers
    const scene = spawnPrefab(a.world, 'scene:late')
    for (const name of ['one', 'two', 'three']) {
      const e = createEntity(a.world)
      setUID(a.world, e, name, { parent: scene })
      setComponent(a.world, e, Health, { current: 50 })
    }
    await peers.tick()
    expect(getEntityByUID(b.world, b.world.worldRoot, 'scene:late')).toBeDefined()

    const cWorld = createWorld({ engine: createEngine(), agent: createAnonAgent('carol') })
    const snap = createSnapshot(a.world)
    applySnapshot(cWorld, snap)

    const cScene = getEntityByUID(cWorld, cWorld.worldRoot, 'scene:late')
    expect(cScene).toBeDefined()
    for (const name of ['one', 'two', 'three']) {
      const e = getEntityByUID(cWorld, cScene!, name)
      expect(e).toBeDefined()
      expect(getComponent(cWorld, e!, Health)?.current).toBe(50)
    }

    const link = connectInMemory(a.world, cWorld)
    setComponent(a.world, getEntityByUID(a.world, scene, 'one')!, Health, { current: 1 })
    await peers.tick()
    await flushAsync()

    expect(getComponent(cWorld, getEntityByUID(cWorld, cScene!, 'one')!, Health)?.current).toBe(1)

    link.close()
    destroyWorld(cWorld)
    peers.dispose()
  })
})

describe('Scenario: three-peer mesh convergence', () => {
  it('mutations from any peer reach all others', async () => {
    const mesh = createPeerMesh(3)
    const [alice, bob, carol] = mesh.peers
    const scene = spawnPrefab(alice.world, 'scene:mesh')
    const e = createEntity(alice.world)
    setUID(alice.world, e, 'p', { parent: scene })
    setComponent(alice.world, e, Health, { current: 30 })

    await mesh.tick()
    await mesh.tick()

    for (const peer of [bob, carol]) {
      const peerScene = getEntityByUID(peer.world, peer.world.worldRoot, 'scene:mesh')!
      const peerE = getEntityByUID(peer.world, peerScene, 'p')!
      expect(getComponent(peer.world, peerE, Health)?.current).toBe(30)
    }

    const bScene = getEntityByUID(bob.world, bob.world.worldRoot, 'scene:mesh')!
    const bE = getEntityByUID(bob.world, bScene, 'p')!
    setComponent(bob.world, bE, Health, { current: 10 })
    await mesh.tick()
    await mesh.tick()
    for (const peer of [alice, carol]) {
      const peerScene = getEntityByUID(peer.world, peer.world.worldRoot, 'scene:mesh')!
      const peerE = getEntityByUID(peer.world, peerScene, 'p')!
      expect(getComponent(peer.world, peerE, Health)?.current).toBe(10)
    }

    mesh.dispose()
  })
})

describe('Property: origin tag suppresses re-broadcast indefinitely', () => {
  it('arbitrary ticks after replication produce no further authored writes from the receiver', async () => {
    const peers = createPeerPair()
    const { a, b } = peers
    const scene = spawnPrefab(a.world, 'scene:prop')
    const e = createEntity(a.world)
    setUID(a.world, e, 'x', { parent: scene })
    setComponent(a.world, e, Health, { current: 7 })
    await peers.tick()
    const startLog = b.world.eventLog.length
    for (let i = 0; i < 5; i++) await peers.tick()
    // After A's write replicated to B, further ticks must not grow B's log —
    // B applied with origin='network' which is not re-enqueued for outbound.
    expect(b.world.eventLog.length).toBe(startLog)
    expect(b.world.authoredQueue).toHaveLength(0)
    peers.dispose()
  })
})
