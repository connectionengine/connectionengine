/**
 * Regression tests for defects found by probing the network layer.
 *
 * Each test here failed before its fix landed. They are grouped by the
 * behaviour they protect rather than by module, because every one of them
 * spans the seam between two peers, which is where these defects lived.
 */

import { describe, expect, it } from 'vitest'
import { Schema } from '../src/schema'
import { createEngine } from '../src/ecs/engine'
import { createManualClock } from '../src/ecs/clock'
import { createAnonAgent, createWorld, destroyWorld, type AuthoredEvent, type World } from '../src/ecs/world'
import { defineComponent, getComponent, setComponent } from '../src/ecs/component'
import { createEntity, getEntityByUID, removeEntity, setUID, getEntityPath } from '../src/ecs/entity'
import { addRelation } from '../src/ecs/relation'
import { spawnPrefab } from '../src/network/prefab'
import { createPeer, createUser } from '../src/network/peer'
import { isPeerConnected } from '../src/network/agents'
import '../src/network/presence'
import { applyAuthoredEnvelope, flushAuthored, flushRuntime } from '../src/network/mutation'
import { addNetwork, ensureDefaultNetwork, validateAuthored } from '../src/network/network'
import { connectInMemory } from '../src/testing/connect-memory'
import { createMemoryTransport, flushAsync } from '../src/network/transport'
import { joinWorld } from '../src/network/lifecycle/session'
import {
  AuthoritativeFor,
  OwnedBy,
  checkAuthorityChangeStanding,
  getAuthority,
  recoverAuthority,
  grantAuthority
} from '../src/network/authority'
import { createPeerPair } from './test-utils/peer-pair'

const Health = defineComponent({
  id: 'RegHealth',
  schema: Schema.Object({ current: Schema.Number({ default: 100 }) })
})

const Pose = defineComponent({
  id: 'RegPose',
  schema: Schema.Object({ position: Schema.Vec3() })
})

const machine = (name: string): World =>
  createWorld({ engine: createEngine({ clock: createManualClock(0) }), agent: createAnonAgent(name) })

/** A minimal inbound event, used to ask a network what its gate says. */
const probeEvent = (): AuthoredEvent => ({
  entityPath: ['probe'],
  predicate: Health.$id,
  op: 'set',
  value: { current: 1 },
  author: 'did:key:OTHER',
  timestamp: 0,
  seq: 0
})

const bootstrap = (world: World, name: string): void => {
  const user = createUser(world, { did: world.localAgent.did, asLocal: true })
  createPeer(world, { user, peerId: `${name}-p`, asLocal: true })
}

describe('same-tick writes that return to a previous value', () => {
  it('replicates the final value when a field goes 50 -> 60 -> 50 in one tick', async () => {
    const p = createPeerPair()
    const e = spawnPrefab(p.a.world, 'thing')
    await p.tick()

    // One flush stamps one timestamp for all three writes. Without a per-event
    // ordinal the third write signs identically to the first and gets dropped
    // as a duplicate, leaving the peers at 50 and 60 forever.
    setComponent(p.a.world, e, Health, { current: 50 })
    setComponent(p.a.world, e, Health, { current: 60 })
    setComponent(p.a.world, e, Health, { current: 50 })
    await p.tick()

    const remote = getEntityByUID(p.b.world, p.b.world.worldRoot, 'thing')!
    expect(getComponent(p.a.world, e, Health)?.current).toBe(50)
    expect(getComponent(p.b.world, remote, Health)?.current).toBe(50)
    p.dispose()
  })

  it('gives two writes of the same value in one tick distinct signatures', () => {
    const world = machine('sig')
    bootstrap(world, 'sig')
    const e = spawnPrefab(world, 'thing')
    setComponent(world, e, Health, { current: 7 })
    setComponent(world, e, Health, { current: 8 })
    setComponent(world, e, Health, { current: 7 })
    const envelope = flushAuthored(world)!
    const healthWrites = envelope.events.filter((ev) => ev.predicate === Health.$id)
    expect(healthWrites).toHaveLength(3)
    expect(new Set(healthWrites.map((ev) => ev.seq)).size).toBe(3)
    destroyWorld(world)
  })
})

describe('relayed topologies', () => {
  it('delivers to a peer reachable only through a middle peer', async () => {
    const a = machine('ra')
    const b = machine('rb')
    const c = machine('rc')
    for (const [w, n] of [
      [a, 'ra'],
      [b, 'rb'],
      [c, 'rc']
    ] as const)
      bootstrap(w, n)

    // A chain, not a mesh: A talks to B, B talks to C, A never talks to C.
    connectInMemory(a, b)
    connectInMemory(b, c)

    const tick = async () => {
      for (const w of [a, b, c]) {
        flushAuthored(w)
        flushRuntime(w)
      }
      await flushAsync()
    }

    spawnPrefab(a, 'relayed')
    await tick()
    await tick()

    expect(getEntityByUID(b, b.worldRoot, 'relayed')).toBeDefined()
    expect(getEntityByUID(c, c.worldRoot, 'relayed')).toBeDefined()
    for (const w of [a, b, c]) destroyWorld(w)
  })

  it('does not relay an event its own gate refused', async () => {
    const a = machine('ga')
    const b = machine('gb')
    const c = machine('gc')
    for (const [w, n] of [
      [a, 'ga'],
      [b, 'gb'],
      [c, 'gc']
    ] as const)
      bootstrap(w, n)

    // B refuses anything carrying Health, so C must never learn about it. The
    // gate goes in with the first connection that builds B's network, because
    // behaviour is fixed at construction.
    connectInMemory(a, b, { onValidateAuthored: (_w, _n, ev) => ev.predicate !== Health.$id })
    connectInMemory(b, c)

    const tick = async () => {
      for (const w of [a, b, c]) {
        flushAuthored(w)
        flushRuntime(w)
      }
      await flushAsync()
    }

    const e = spawnPrefab(a, 'guarded')
    setComponent(a, e, Health, { current: 5 })
    await tick()
    await tick()

    const onC = getEntityByUID(c, c.worldRoot, 'guarded')
    expect(onC).toBeDefined()
    expect(getComponent(c, onC!, Health)).toBeUndefined()
    for (const w of [a, b, c]) destroyWorld(w)
  })

  it('reports a rejected event through onRejected', async () => {
    const rejected: Array<{ event: AuthoredEvent; reason: string }> = []
    const p = createPeerPair({
      transport: {
        onValidateAuthored: (_w, _n, ev) => ev.predicate !== Health.$id,
        onRejected: (_w, _n, event, reason) => rejected.push({ event, reason })
      }
    })

    const e = spawnPrefab(p.a.world, 'watched')
    setComponent(p.a.world, e, Health, { current: 3 })
    await p.tick()

    expect(rejected).toHaveLength(1)
    expect(rejected[0].event.predicate).toBe(Health.$id)
    expect(rejected[0].reason).toBe('governance')
    p.dispose()
  })
})

describe('authority transfer', () => {
  it('emits one event, so a receiver never lands on no authority at all', () => {
    const world = machine('auth')
    const owner = createUser(world, { did: 'did:key:OWNER', asLocal: true })
    const holderUser = createUser(world, { did: 'did:key:HOLDER' })
    const holderPeer = createPeer(world, { user: holderUser, peerId: 'holder-p' })
    const nextUser = createUser(world, { did: 'did:key:NEXT' })
    const nextPeer = createPeer(world, { user: nextUser, peerId: 'next-p' })

    const e = createEntity(world)
    setUID(world, e, 'vehicle')
    addRelation(world, e, OwnedBy, owner)
    addRelation(world, e, AuthoritativeFor, holderPeer)
    flushAuthored(world)

    grantAuthority(world, e, nextPeer)
    const envelope = flushAuthored(world)!
    const authorityEvents = envelope.events.filter((ev) => ev.predicate === AuthoritativeFor.name)
    expect(authorityEvents).toHaveLength(1)
    expect(authorityEvents[0].op).toBe('set')
    // Exclusivity drops the previous holder without a separate remove event.
    expect(getAuthority(world, e)).toBe(nextPeer)
    destroyWorld(world)
  })

  it('accepts a transfer authored by the current authority (host migration)', () => {
    const world = machine('migrate')
    const owner = createUser(world, { did: 'did:key:OWNER', asLocal: true })
    const holderUser = createUser(world, { did: 'did:key:HOLDER' })
    const holderPeer = createPeer(world, { user: holderUser, peerId: 'holder-p' })
    const nextUser = createUser(world, { did: 'did:key:NEXT' })
    const nextPeer = createPeer(world, { user: nextUser, peerId: 'next-p' })

    const e = createEntity(world)
    setUID(world, e, 'vehicle')
    addRelation(world, e, OwnedBy, owner)
    addRelation(world, e, AuthoritativeFor, holderPeer)

    const setEvt: AuthoredEvent = {
      entityPath: getEntityPath(world, e),
      predicate: AuthoritativeFor.name,
      op: 'set',
      value: { targetPath: getEntityPath(world, nextPeer) },
      author: 'did:key:HOLDER',
      timestamp: 1,
      seq: 0
    }
    expect(checkAuthorityChangeStanding(world, setEvt)).toBeUndefined()
    destroyWorld(world)
  })

  it('recovers authority to a peer, never to an ordinary child of the owner', () => {
    const world = machine('recover')
    const user = createUser(world, { did: 'did:key:U', asLocal: true })
    const gone = createPeer(world, { user, peerId: 'gone-p' })
    const alive = createPeer(world, { user, peerId: 'alive-p' })
    // An ordinary entity parented to the user. It shares the parentOf index
    // with the peers but must never be picked as an authority.
    const belonging = createEntity(world)
    setUID(world, belonging, 'backpack', { parent: user })

    const e = createEntity(world)
    setUID(world, e, 'vehicle')
    addRelation(world, e, OwnedBy, user)
    addRelation(world, e, AuthoritativeFor, gone)

    recoverAuthority(world, e, gone)
    const successor = getAuthority(world, e)
    expect(successor).not.toBe(belonging)
    expect([gone, alive]).toContain(successor)
    expect(successor).toBe(alive)
    destroyWorld(world)
  })
})

describe('entity destruction', () => {
  it('replicates plain removeEntity, with no networked twin to call', async () => {
    const p = createPeerPair()
    const e = spawnPrefab(p.a.world, 'doomed')
    await p.tick()
    expect(getEntityByUID(p.b.world, p.b.world.worldRoot, 'doomed')).toBeDefined()

    removeEntity(p.a.world, e)
    await p.tick()

    expect(getEntityByUID(p.b.world, p.b.world.worldRoot, 'doomed')).toBeUndefined()
    p.dispose()
  })

  it('does not echo a received destroy back out', async () => {
    const p = createPeerPair()
    const e = spawnPrefab(p.a.world, 'doomed2')
    await p.tick()
    removeEntity(p.a.world, e)
    await p.tick()
    // B applied the destroy. Its own queue must stay empty, or the two peers
    // would trade the same destroy forever.
    expect(p.b.world.authoredQueue).toHaveLength(0)
    p.dispose()
  })

  it('queues nothing for an entity with no wire identity', () => {
    const world = machine('anon')
    bootstrap(world, 'anon')
    flushAuthored(world)
    const e = createEntity(world)
    removeEntity(world, e)
    expect(world.authoredQueue).toHaveLength(0)
    destroyWorld(world)
  })

  it('does not author when a disconnect sweep removes owned entities', async () => {
    const p = createPeerPair()
    spawnPrefab(p.a.world, 'owned-thing')
    await p.tick()
    const before = p.b.world.eventLog.length

    p.link.close()
    await p.flush()

    // B swept A's entities locally. That sweep must not become an authored
    // destroy, or it would travel to peers that never lost A.
    expect(p.b.world.authoredQueue).toHaveLength(0)
    expect(p.b.world.eventLog.length).toBe(before)
    p.dispose()
  })
})

describe('replay cursor', () => {
  it('replays from the start when the cursor does not name a shared prefix', async () => {
    const host = machine('cur-host')
    bootstrap(host, 'cur-host')
    const e = spawnPrefab(host, 'scene')
    setComponent(host, e, Health, { current: 12 })
    flushAuthored(host)

    // A joiner with a log of its own. Its length is a meaningless index into
    // the host's log, so a cursor honoured blindly would skip real history.
    const joiner = machine('cur-join')
    bootstrap(joiner, 'cur-join')
    spawnPrefab(joiner, 'local-only')
    flushAuthored(joiner)
    expect(joiner.eventLog.length).toBeGreaterThan(0)

    const link = createMemoryTransport()
    await Promise.all([
      joinWorld(host, { endpoint: link.a, knownEventCount: host.eventLog.length }),
      joinWorld(joiner, { endpoint: link.b, knownEventCount: joiner.eventLog.length })
    ])

    const scene = getEntityByUID(joiner, joiner.worldRoot, 'scene')
    expect(scene).toBeDefined()
    expect(getComponent(joiner, scene!, Health)?.current).toBe(12)
    link.close()
    destroyWorld(host)
    destroyWorld(joiner)
  })
})

describe('runtime throttling', () => {
  it('still delivers a movement that the publish rate deferred', async () => {
    const a = machine('thr-a')
    const b = machine('thr-b')
    bootstrap(a, 'thr-a')
    bootstrap(b, 'thr-b')
    // One publish every four ticks, against a 60 Hz simulation.
    const link = connectInMemory(a, b, {
      runtimeComponents: [Pose],
      runtimeConfigs: [{ componentIds: [Pose.$id], rate: 15 }]
    })

    const e = spawnPrefab(a, 'mover')
    setComponent(a, e, Pose, { position: [0, 0, 0] })
    flushAuthored(a)
    flushRuntime(a)
    await flushAsync()

    // Move once, then stop. The write lands on a tick the throttle skips.
    Pose.position.x[e] = 42
    a.runtimeDirty.get(Pose.$id)!.add(e)
    flushRuntime(a)
    await flushAsync()
    for (let i = 0; i < 6; i++) {
      flushRuntime(a)
      await flushAsync()
    }

    const remote = getEntityByUID(b, b.worldRoot, 'mover')!
    expect(Pose.position.x[remote]).toBeCloseTo(42)
    link.close()
    destroyWorld(a)
    destroyWorld(b)
  })
})

describe('ownership gates outbound removal', () => {
  it('a peer does not announce the removal of an entity it does not own', async () => {
    const p = createPeerPair()
    spawnPrefab(p.a.world, 'alices-thing')
    await p.tick()

    // B holds a copy, but A owns it. B removing it locally is B's own business
    // and must not travel, or one peer could delete another peer's data.
    const onB = getEntityByUID(p.b.world, p.b.world.worldRoot, 'alices-thing')!
    removeEntity(p.b.world, onB)
    expect(p.b.world.authoredQueue).toHaveLength(0)
    await p.tick()

    expect(getEntityByUID(p.a.world, p.a.world.worldRoot, 'alices-thing')).toBeDefined()
    p.dispose()
  })

  it('a disconnect sweep does not author the removals it performs', async () => {
    const p = createPeerPair()
    spawnPrefab(p.a.world, 'owned-thing')
    await p.tick()
    const before = p.b.world.eventLog.length

    p.link.close()
    await p.flush()

    // B swept the entities of the departing user. Those belong to A, so the
    // ownership gate keeps the sweep local — as every peer runs its own.
    expect(p.b.world.authoredQueue).toHaveLength(0)
    expect(p.b.world.eventLog.length).toBe(before)
    p.dispose()
  })
})

describe('presence derives disconnect cleanup', () => {
  it('sweeps the entities of a departed user without anyone calling a sweep', async () => {
    const p = createPeerPair()
    spawnPrefab(p.a.world, 'alices-thing')
    await p.tick()
    expect(getEntityByUID(p.b.world, p.b.world.worldRoot, 'alices-thing')).toBeDefined()

    // Nothing invokes cleanup. Closing drops `ConnectedTo`, and the observer
    // on that removal does the rest.
    p.link.close()
    await p.flush()

    expect(getEntityByUID(p.b.world, p.b.world.worldRoot, 'alices-thing')).toBeUndefined()
    p.dispose()
  })

  it('marks a peer connected while the link is open and disconnected after', async () => {
    const p = createPeerPair()
    await p.tick()
    const alicePeerOnB = p.link.b.peer
    expect(isPeerConnected(p.b.world, alicePeerOnB)).toBe(true)

    p.link.close()
    await p.flush()
    expect(isPeerConnected(p.b.world, alicePeerOnB)).toBe(false)
    p.dispose()
  })

  it('recovers authority from the departed peer to one that remains', async () => {
    const p = createPeerPair()
    const thing = spawnPrefab(p.b.world, 'bobs-thing')
    await p.tick()

    // A holds a copy authored by B. When B drops, A must hand the authority to
    // a peer it still has — its own — rather than leave the entity frozen.
    const onA = getEntityByUID(p.a.world, p.a.world.worldRoot, 'bobs-thing')!
    const bPeerOnA = p.link.a.peer
    expect(getAuthority(p.a.world, onA)).toBe(bPeerOnA)

    p.link.close()
    await p.flush()

    // B's entities are swept on A, so the entity is gone entirely — which is
    // the stronger outcome, and proves the observer ran.
    expect(getEntityByUID(p.a.world, p.a.world.worldRoot, 'bobs-thing')).toBeUndefined()
    void thing
    p.dispose()
  })

  it('survives the reentrancy of removals triggering further observers', async () => {
    const p = createPeerPair()
    const parent = spawnPrefab(p.a.world, 'parent')
    spawnPrefab(p.a.world, 'child', { parent })
    spawnPrefab(p.a.world, 'sibling')
    await p.tick()

    // Removing the owner's entities fires the destroy observer for each, which
    // runs while the disconnect observer is still on the stack.
    expect(() => {
      p.link.close()
    }).not.toThrow()
    await p.flush()

    for (const uid of ['parent', 'child', 'sibling']) {
      expect(getEntityByUID(p.b.world, p.b.world.worldRoot, uid)).toBeUndefined()
    }
    // The cleanup is local, so it must not have queued anything outbound.
    expect(p.b.world.authoredQueue).toHaveLength(0)
    p.dispose()
  })
})

describe('network behaviour is fixed at construction', () => {
  it('ensureDefaultNetwork ignores behaviour options for a network that already exists', () => {
    const world = machine('fixed')
    bootstrap(world, 'fixed')

    const first = ensureDefaultNetwork(world, { onValidateAuthored: () => false })
    // A second caller must not be able to re-teach the network. If this ever
    // starts applying, behaviour becomes a function of call order and the
    // readonly fields buy nothing.
    const second = ensureDefaultNetwork(world, { onValidateAuthored: () => true })

    expect(second).toBe(first)
    expect(validateAuthored(world, second, probeEvent())).toBe(false)
    destroyWorld(world)
  })

  it('a network built with no gate admits everything', () => {
    const world = machine('open')
    bootstrap(world, 'open')
    const network = addNetwork(world, { id: 'open' })
    expect(validateAuthored(world, network, probeEvent())).toBe(true)
    destroyWorld(world)
  })

  it('a rejected event reaches the onRejected behaviour of its own network', () => {
    const world = machine('reported')
    bootstrap(world, 'reported')
    const seen: string[] = []
    const network = addNetwork(world, {
      id: 'reported',
      onValidateAuthored: () => false,
      onRejected: (_w, _n, event, reason) => seen.push(`${event.predicate}:${reason}`)
    })

    const accepted = applyAuthoredEnvelope(world, { fromPeer: 'did:key:OTHER', events: [probeEvent()] }, network)

    expect(accepted).toHaveLength(0)
    expect(seen).toEqual([`${Health.$id}:governance`])
    expect(world.eventLog).toHaveLength(0)
    destroyWorld(world)
  })
})

describe('worlds with no continuous components', () => {
  it('connects without a binary channel rather than throwing', async () => {
    // Every component in this file is authored-only, so the default continuous
    // list is empty. Building a pipeline over zero components throws, so the
    // connection must simply go without one.
    const a = machine('nosoa-a')
    const b = machine('nosoa-b')
    bootstrap(a, 'nosoa-a')
    bootstrap(b, 'nosoa-b')

    const link = connectInMemory(a, b, { runtimeComponents: [] })
    expect(link.a.channel).toBeUndefined()
    expect(link.b.channel).toBeUndefined()

    // The authored path still works, which is the whole point.
    const e = spawnPrefab(a, 'authored-only')
    setComponent(a, e, Health, { current: 42 })
    flushAuthored(a)
    flushRuntime(a)
    await flushAsync()

    const remote = getEntityByUID(b, b.worldRoot, 'authored-only')!
    expect(getComponent(b, remote, Health)?.current).toBe(42)

    link.close()
    destroyWorld(a)
    destroyWorld(b)
  })
})
