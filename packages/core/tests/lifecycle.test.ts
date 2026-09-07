/**
 * Peer connection lifecycle — joinWorld / leaveWorld / late-join via event-log
 * replay / owner-user sweep on last disconnect.
 *
 * These tests exercise the formal session protocol end-to-end. The simpler
 * `connectInMemory` shortcut is tested in integration.test.ts.
 */

import { describe, expect, it } from 'vitest'
import {
  AuthoritativeFor,
  applyAuthoredEnvelope,
  createAnonAgent,
  createEngine,
  createEntity,
  createMemoryTransport,
  createPeer,
  createUser,
  createWorld,
  defineComponent,
  destroyWorld,
  entityExists,
  findPeerByIdForUser,
  findUserByDID,
  flushAsync,
  flushAuthored,
  flushRuntime,
  getAuthority,
  getComponent,
  getEntityByUID,
  getNetwork,
  hasComponent,
  joinWorld,
  leaveWorld,
  Schema,
  setAuthority,
  setComponent,
  setUID,
  spawnPrefab
} from '../src'

/**
 * Lifecycle tests model multiple physical machines — host + joiner — each
 * with its own engine. Identity caches live as per-engine WeakMaps on the
 * UIDComponent / BelongsTo definitions, so each peer's `worldRoot` subtree
 * stays isolated. The thin wrapper makes the intent explicit at every call.
 */
const machine = (name: string): ReturnType<typeof createWorld> =>
  createWorld({ engine: createEngine(), agent: createAnonAgent(name) })

const machineFor = (did: string): ReturnType<typeof createWorld> =>
  createWorld({ engine: createEngine(), agent: { did } })

const Health = defineComponent({
  id: 'LC.Health',
  schema: Schema.Object({
    current: Schema.Number({ default: 100 }),
    max: Schema.Number({ default: 100 })
  })
})

/**
 * Continuous-channel component — SoA-tagged, so it never enters the event log
 * and only ever ships as a binary delta while dirty.
 */
const Position = defineComponent({
  id: 'LC.Position',
  schema: Schema.Object({ position: Schema.Vec3() })
})

/** Local identity bootstrap — equivalent to `createUser + createPeer` with
 *  asLocal so `spawnPrefab` has defaults to draw on. */
const bootstrap = (world: ReturnType<typeof createWorld>, name: string) => {
  const user = createUser(world, { did: world.localAgent.did, asLocal: true })
  createPeer(world, { user, peerId: `${name}-p`, asLocal: true })
}

describe('joinWorld — handshake + event-log replay', () => {
  it('joiner catches up by replaying host event log', async () => {
    // Host builds state first
    const host = machine('host')
    bootstrap(host, 'host')
    const scene = spawnPrefab(host, 'scene:replay')
    for (const name of ['a', 'b', 'c']) {
      const e = createEntity(host)
      setUID(host, e, name, { parent: scene })
      setComponent(host, e, Health, { current: 50 })
    }
    // Drain queued authored writes into the event log so the joiner sees them
    // on replay. (In production this happens at end-of-tick via runSystems.)
    flushAuthored(host)
    expect(host.eventLog.length).toBeGreaterThan(0)
    const hostLogLen = host.eventLog.length

    // Joiner is fresh — no state
    const joiner = machine('joiner')
    expect(joiner.eventLog.length).toBe(0)

    // Wire transport + initiate join from BOTH sides
    const link = createMemoryTransport()
    const [hostResult, joinerResult] = await Promise.all([
      joinWorld(host, { endpoint: link.a, knownEventCount: host.eventLog.length }),
      joinWorld(joiner, { endpoint: link.b, knownEventCount: 0 })
    ])
    void hostResult

    // Joiner replayed all of host's events
    expect(joinerResult.replayedEventCount).toBe(hostLogLen)
    expect(joiner.eventLog.length).toBe(hostLogLen)

    // State is convergent: every named entity from host exists on joiner with same data
    const joinerScene = getEntityByUID(joiner, joiner.worldRoot, 'scene:replay')
    expect(joinerScene).toBeDefined()
    for (const name of ['a', 'b', 'c']) {
      const je = getEntityByUID(joiner, joinerScene!, name)
      expect(je).toBeDefined()
      expect(getComponent(joiner, je!, Health)?.current).toBe(50)
    }
    link.close()
    destroyWorld(host)
    destroyWorld(joiner)
  })

  it('replay is idempotent — joining twice does not double-apply', async () => {
    const host = machine('host2')
    bootstrap(host, 'host2')
    const scene = spawnPrefab(host, 'scene:idem')
    const e = createEntity(host)
    setUID(host, e, 'x', { parent: scene })
    setComponent(host, e, Health, { current: 30 })
    flushAuthored(host)

    const joiner = machine('joiner2')

    const link1 = createMemoryTransport()
    await Promise.all([joinWorld(host, { endpoint: link1.a }), joinWorld(joiner, { endpoint: link1.b })])
    const afterFirst = joiner.eventLog.length
    link1.close()

    // Reconnect a second time — known event count is the current log length,
    // so host should send 0 new events.
    const link2 = createMemoryTransport()
    const [, joinerR] = await Promise.all([
      joinWorld(host, { endpoint: link2.a, knownEventCount: host.eventLog.length }),
      joinWorld(joiner, { endpoint: link2.b, knownEventCount: joiner.eventLog.length })
    ])
    expect(joinerR.replayedEventCount).toBe(0)
    expect(joiner.eventLog.length).toBe(afterFirst)
    link2.close()
    destroyWorld(host)
    destroyWorld(joiner)
  })

  it('live envelopes flow after the replay phase completes', async () => {
    const host = machine('live-host')
    bootstrap(host, 'live-host')
    const scene = spawnPrefab(host, 'scene:live')
    const e = createEntity(host)
    setUID(host, e, 'thing', { parent: scene })
    setComponent(host, e, Health, { current: 10 })
    flushAuthored(host)

    const joiner = machine('live-joiner')

    const link = createMemoryTransport()
    await Promise.all([joinWorld(host, { endpoint: link.a }), joinWorld(joiner, { endpoint: link.b })])

    // After join, host updates state; joiner should pick it up via live stream
    setComponent(host, e, Health, { current: 99 })
    // Manually invoke publishAuthored by emulating flush — the lifecycle wires it
    // (joinWorld calls installFanout on the default network)
    getNetwork(host, 'default')?.publishAuthored?.({
      fromPeer: host.localAgent.did,
      events: [
        {
          author: host.localAgent.did,
          timestamp: host.engine.clock.now(),
          op: 'set',
          predicate: 'LC.Health',
          entityPath: ['scene:live', 'thing'],
          value: { current: 99, max: 100 }
        }
      ]
    })
    await flushAsync()

    const jScene = getEntityByUID(joiner, joiner.worldRoot, 'scene:live')!
    const jThing = getEntityByUID(joiner, jScene, 'thing')!
    expect(getComponent(joiner, jThing, Health)?.current).toBe(99)

    link.close()
    destroyWorld(host)
    destroyWorld(joiner)
  })
})

describe('joinWorld — continuous-channel bootstrap via state snapshot', () => {
  /**
   * Replay carries a continuous component's *existence* and the pose it was
   * created with — that write is authored. What it cannot carry is any
   * subsequent motion, which only ever rides the binary delta channel. And that
   * channel only ships entities in the current dirty set, so an entity that has
   * since stopped moving is reachable by neither live path. The join snapshot
   * is what closes the gap between the creation pose and the current one.
   */
  const restingHost = (name: string) => {
    const host = machine(name)
    bootstrap(host, name)
    const scene = spawnPrefab(host, `scene:${name}`)
    const rock = createEntity(host)
    setUID(host, rock, 'rock', { parent: scene })
    setComponent(host, rock, Position, { position: [1, 2, 3] })
    setComponent(host, rock, Health, { current: 42 })
    // Then it moves — this write authors nothing, it only marks dirty.
    setComponent(host, rock, Position, { position: [9, 9, 9] })
    // End of tick: authored writes land in the log, the runtime dirty set is
    // drained with no connections attached. The rock is now at rest, and the
    // event log's record of it is stale by one move.
    flushAuthored(host)
    flushRuntime(host)
    expect(host.runtimeDirty.get('LC.Position')?.size ?? 0).toBe(0)
    return host
  }

  it('late joiner receives continuous state for an entity that is no longer dirty', async () => {
    const host = restingHost('snap-host')
    const joiner = machine('snap-joiner')

    const link = createMemoryTransport()
    const [, joinerResult] = await Promise.all([
      joinWorld(host, { endpoint: link.a, knownEventCount: host.eventLog.length }),
      joinWorld(joiner, { endpoint: link.b, knownEventCount: 0 })
    ])

    expect(joinerResult.snapshotEntityCount).toBeGreaterThan(0)

    const jScene = getEntityByUID(joiner, joiner.worldRoot, 'scene:snap-host')!
    const jRock = getEntityByUID(joiner, jScene, 'rock')!
    expect(hasComponent(joiner, jRock, Position)).toBe(true)
    // The *current* pose, not the one the creating event recorded.
    expect(Array.from(Position.position.to(jRock))).toEqual([9, 9, 9])
    // Event-channel state still arrives, unchanged by the snapshot phase.
    expect(getComponent(joiner, jRock, Health)?.current).toBe(42)

    link.close()
    destroyWorld(host)
    destroyWorld(joiner)
  })

  it('without the snapshot the joiner is stuck at the creation pose', async () => {
    const host = restingHost('nosnap-host')
    const joiner = machine('nosnap-joiner')

    const link = createMemoryTransport()
    const [, joinerResult] = await Promise.all([
      joinWorld(host, { endpoint: link.a, knownEventCount: host.eventLog.length, sendStateSnapshot: false }),
      joinWorld(joiner, { endpoint: link.b, knownEventCount: 0, sendStateSnapshot: false })
    ])

    expect(joinerResult.snapshotEntityCount).toBe(0)

    const jScene = getEntityByUID(joiner, joiner.worldRoot, 'scene:nosnap-host')!
    const jRock = getEntityByUID(joiner, jScene, 'rock')!
    expect(getComponent(joiner, jRock, Health)?.current).toBe(42)
    // Replay establishes the component and the pose it was created with — the
    // move that followed was never authored, so the joiner never learns of it.
    expect(hasComponent(joiner, jRock, Position)).toBe(true)
    expect(Array.from(Position.position.to(jRock))).toEqual([1, 2, 3])

    link.close()
    destroyWorld(host)
    destroyWorld(joiner)
  })

  it('applying the snapshot does not re-emit — joiner authors nothing of its own', async () => {
    const host = restingHost('quiet-host')
    const joiner = machine('quiet-joiner')

    const link = createMemoryTransport()
    await Promise.all([
      joinWorld(host, { endpoint: link.a, knownEventCount: host.eventLog.length }),
      joinWorld(joiner, { endpoint: link.b, knownEventCount: 0 })
    ])

    // Snapshot applies with origin='network': no authored queue entries, no
    // runtime dirty flags, so nothing echoes back to the host.
    expect(joiner.authoredQueue.length).toBe(0)
    expect(joiner.runtimeDirty.get('LC.Position')?.size ?? 0).toBe(0)

    link.close()
    destroyWorld(host)
    destroyWorld(joiner)
  })
})

describe('leaveWorld — graceful disconnect + owner-user sweep', () => {
  it('removes every entity owned by the leaving user when no peers remain', async () => {
    const host = machine('cleanup-host')
    const hostUser = createUser(host, { did: host.localAgent.did, asLocal: true })
    createPeer(host, { user: hostUser, peerId: 'host-p', asLocal: true })

    const joiner = machine('cleanup-joiner')
    const joinerUser = createUser(joiner, { did: joiner.localAgent.did, asLocal: true })
    createPeer(joiner, { user: joinerUser, peerId: 'joiner-p', asLocal: true })

    // Host also has a record of the joiner user at the same UID the joiner
    // will encode in HELLO — `user:<did>` is the default.
    const hostJoinerUser = createUser(host, { did: joiner.localAgent.did })

    // Host creates an avatar OWNED BY the joiner user. No opt-in tag — every
    // user-owned entity is swept on the user's last disconnect.
    const avatar = spawnPrefab(host, 'avatar:joiner', {
      owner: hostJoinerUser,
      parent: spawnPrefab(host, 'scene:cleanup')
    })

    // Connect
    const link = createMemoryTransport()
    const [{ connection: hostConn }] = await Promise.all([
      joinWorld(host, { endpoint: link.a }),
      joinWorld(joiner, { endpoint: link.b })
    ])

    // Pre-leave: avatar exists on host
    expect(entityExists(host, avatar)).toBe(true)

    // Joiner leaves
    await leaveWorld(joiner, getNetwork(joiner, 'default')!.connections.values().next().value!)
    await flushAsync()

    // Host received the leave signal → swept everything the joiner-user owned
    expect(entityExists(host, avatar)).toBe(false)

    void hostConn
    destroyWorld(host)
    destroyWorld(joiner)
  })

  it('does NOT sweep when the user has another live peer connection', async () => {
    const userDID = 'did:test:multi-user'
    const host = machine('multi-host')
    const hostUser = createUser(host, { did: host.localAgent.did, asLocal: true })
    createPeer(host, { user: hostUser, peerId: 'host-p', asLocal: true })

    const joinerA = machineFor(userDID)
    const joinerAUser = createUser(joinerA, { did: userDID, asLocal: true })
    createPeer(joinerA, { user: joinerAUser, peerId: 'device-A', asLocal: true })

    const joinerB = machineFor(userDID)
    const joinerBUser = createUser(joinerB, { did: userDID, asLocal: true })
    createPeer(joinerB, { user: joinerBUser, peerId: 'device-B', asLocal: true })

    // Host pre-knows the user under the same UID HELLO will use
    const user = createUser(host, { did: userDID })
    const avatar = spawnPrefab(host, 'avatar:multi', {
      owner: user,
      parent: spawnPrefab(host, 'scene:multi')
    })

    const link1 = createMemoryTransport()
    const link2 = createMemoryTransport()
    await Promise.all([joinWorld(host, { endpoint: link1.a }), joinWorld(joinerA, { endpoint: link1.b })])
    await Promise.all([joinWorld(host, { endpoint: link2.a }), joinWorld(joinerB, { endpoint: link2.b })])

    // Joiner A leaves
    await leaveWorld(joinerA, getNetwork(joinerA, 'default')!.connections.values().next().value!)
    await flushAsync()

    // Avatar should SURVIVE because joiner B still connected for the same user
    expect(entityExists(host, avatar)).toBe(true)

    // Now joiner B leaves too
    await leaveWorld(joinerB, getNetwork(joinerB, 'default')!.connections.values().next().value!)
    await flushAsync()

    // Now the avatar is swept
    expect(entityExists(host, avatar)).toBe(false)

    destroyWorld(host)
    destroyWorld(joinerA)
    destroyWorld(joinerB)
  })
})

describe('Authority — receive-side gate', () => {
  it('rejects an AuthoritativeFor change from a peer with no standing', () => {
    const host = machine('rg-host')
    // Set up the local owner-user + peer
    const hostUser = createUser(host, { did: 'did:test:host', uid: 'user:host', asLocal: true })
    const hostPeer = createPeer(host, { user: hostUser, peerId: 'host-p', uid: 'peer:host-p', asLocal: true })
    // An entity owned by hostUser, authority = hostPeer
    const scene = spawnPrefab(host, 'scene:rg')
    const e = spawnPrefab(host, 'thing', { parent: scene })
    // A rogue user-peer exists locally (e.g. received via prior replay)
    const rogueUser = createUser(host, { did: 'did:test:rogue', uid: 'user:rogue' })
    const roguePeer = createPeer(host, { user: rogueUser, peerId: 'rogue-p', uid: 'peer:rogue-p' })

    // Forge an envelope from the rogue DID trying to take authority
    applyAuthoredEnvelope(host, {
      fromPeer: 'did:test:rogue',
      events: [
        {
          entityPath: ['scene:rg', 'thing'],
          predicate: AuthoritativeFor.name,
          op: 'set',
          value: { targetPath: ['user:rogue', 'peer:rogue-p'] },
          author: 'did:test:rogue',
          timestamp: 0
        }
      ]
    })

    // Authority unchanged — the receive-side standing check dropped the
    // forged event before applyEvent ran.
    expect(getAuthority(host, e)).toBe(hostPeer)
    void roguePeer
    destroyWorld(host)
  })

  it('accepts an AuthoritativeFor change from the owner-user DID', () => {
    const host = machine('ag-host')
    const hostUser = createUser(host, { did: 'did:test:host2', uid: 'user:host2', asLocal: true })
    createPeer(host, { user: hostUser, peerId: 'host-p', uid: 'peer:host-p', asLocal: true })
    const scene = spawnPrefab(host, 'scene:ag')
    const e = spawnPrefab(host, 'thing2', { parent: scene })
    // A second device for the same user — owner's DID matches.
    const otherPeer = createPeer(host, { user: hostUser, peerId: 'host-p2', uid: 'peer:host-p2' })

    applyAuthoredEnvelope(host, {
      fromPeer: 'did:test:host2',
      events: [
        {
          entityPath: ['scene:ag', 'thing2'],
          predicate: AuthoritativeFor.name,
          op: 'set',
          value: { targetPath: ['user:host2', 'peer:host-p2'] },
          author: 'did:test:host2',
          timestamp: 0
        }
      ]
    })

    expect(getAuthority(host, e)).toBe(otherPeer)
    destroyWorld(host)
  })
})

describe('Authority — auto-recovery on disconnect', () => {
  it('reassigns authority away from the leaving peer via the sweep', async () => {
    const host = machine('rec-host')
    const hostUser = createUser(host, { did: 'did:test:rec-host', uid: 'user:rec-host', asLocal: true })
    const hostPeer = createPeer(host, { user: hostUser, peerId: 'host', uid: 'peer:host', asLocal: true })

    const joiner = machine('rec-joiner')
    const joinerUser = createUser(joiner, { did: 'did:test:rec-joiner', uid: 'user:rec-joiner', asLocal: true })
    createPeer(joiner, { user: joinerUser, peerId: 'joiner', uid: 'peer:joiner', asLocal: true })

    // Connect — HELLO materialises remote user+peer entities on each side.
    const link = createMemoryTransport()
    await Promise.all([joinWorld(host, { endpoint: link.a }), joinWorld(joiner, { endpoint: link.b })])
    await flushAsync()

    // On the host, find the materialised joiner peer entity.
    const hostJoinerUser = findUserByDID(host, 'did:test:rec-joiner')!
    const hostJoinerPeer = findPeerByIdForUser(host, hostJoinerUser, 'joiner')!
    expect(hostJoinerPeer).toBeDefined()

    // Host creates an entity, hands authority to the joiner peer.
    const scene = spawnPrefab(host, 'scene:rec')
    const e = spawnPrefab(host, 'shared', { parent: scene })
    // Transfer authority — hostPeer (local) has standing as the current holder.
    setAuthority(host, e, hostJoinerPeer)
    expect(getAuthority(host, e)).toBe(hostJoinerPeer)

    // Joiner disconnects
    await leaveWorld(joiner, getNetwork(joiner, 'default')!.connections.values().next().value!)
    await flushAsync()

    // Sweep should have moved authority off the disconnected peer.
    const after = getAuthority(host, e)
    expect(after).not.toBe(hostJoinerPeer)
    // Falls back to the lowest available peer of the owner — here, hostPeer.
    expect(after).toBe(hostPeer)

    destroyWorld(host)
    destroyWorld(joiner)
  })
})

describe('Sanity: applyAuthoredEnvelope works alongside lifecycle', () => {
  it('a joined world still accepts direct envelope applies (for tests)', async () => {
    const host = machine('sanity')
    const peer = machine('sanity-peer')
    const link = createMemoryTransport()
    await Promise.all([joinWorld(host, { endpoint: link.a }), joinWorld(peer, { endpoint: link.b })])

    applyAuthoredEnvelope(host, {
      fromPeer: 'did:test:direct',
      events: [
        {
          entityPath: ['x'],
          predicate: 'LC.Health',
          op: 'set',
          value: { current: 7, max: 10 },
          author: 'did:test:direct',
          timestamp: 0
        }
      ]
    })
    expect(host.eventLog.at(-1)?.value).toEqual({ current: 7, max: 10 })

    link.close()
    destroyWorld(host)
    destroyWorld(peer)
  })
})
