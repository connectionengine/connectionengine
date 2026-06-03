/**
 * Peer connection lifecycle — joinWorld / leaveWorld / late-join via event-log
 * replay / TransientOnDisconnect deep cleanup.
 *
 * These tests exercise the formal session protocol end-to-end. The simpler
 * `connectInMemory` shortcut is tested in integration.test.ts.
 */

import { describe, expect, it } from 'vitest'
import {
  applyAuthoredEnvelope,
  createAnonAgent,
  createEntity,
  createMemoryTransport,
  createNamedEntity,
  createPeer,
  createUser,
  createWorld,
  defineComponent,
  destroyWorld,
  flushAsync,
  flushAuthored,
  getComponent,
  getEntityByUID,
  hasComponent,
  joinWorld,
  leaveWorld,
  Schema,
  setComponent,
  setOwner,
  setUID,
  TransientOnDisconnect
} from '../src'

const Health = defineComponent({
  id: 'LC.Health',
  schema: Schema.Object({
    current: Schema.Number({ default: 100 }),
    max: Schema.Number({ default: 100 })
  })
})

describe('joinWorld — handshake + event-log replay', () => {
  it('joiner catches up by replaying host event log; no snapshot involved', async () => {
    // Host builds state first
    const host = createWorld({ agent: createAnonAgent('host') })
    const scene = createNamedEntity(host, 'scene:replay')
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
    const joiner = createWorld({ agent: createAnonAgent('joiner') })
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
    const joinerScene = getEntityByUID(joiner, 0, 'scene:replay')
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
    const host = createWorld({ agent: createAnonAgent('host2') })
    const scene = createNamedEntity(host, 'scene:idem')
    const e = createEntity(host)
    setUID(host, e, 'x', { parent: scene })
    setComponent(host, e, Health, { current: 30 })
    flushAuthored(host)

    const joiner = createWorld({ agent: createAnonAgent('joiner2') })

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
    const host = createWorld({ agent: createAnonAgent('live-host') })
    const scene = createNamedEntity(host, 'scene:live')
    const e = createEntity(host)
    setUID(host, e, 'thing', { parent: scene })
    setComponent(host, e, Health, { current: 10 })
    flushAuthored(host)

    const joiner = createWorld({ agent: createAnonAgent('live-joiner') })

    const link = createMemoryTransport()
    await Promise.all([joinWorld(host, { endpoint: link.a }), joinWorld(joiner, { endpoint: link.b })])

    // After join, host updates state; joiner should pick it up via live stream
    setComponent(host, e, Health, { current: 99 })
    // Manually invoke publishAuthored by emulating flush — the lifecycle wires it
    // (joinWorld calls installLifecycleFanout)
    host.network.publishAuthored?.({
      fromPeer: host.network.localAgent.did,
      events: [
        {
          author: host.network.localAgent.did,
          timestamp: host.clock.now(),
          op: 'set',
          predicate: 'LC.Health',
          entityPath: ['scene:live', 'thing'],
          value: { current: 99, max: 100 }
        }
      ]
    })
    await flushAsync()

    const jScene = getEntityByUID(joiner, 0, 'scene:live')!
    const jThing = getEntityByUID(joiner, jScene, 'thing')!
    expect(getComponent(joiner, jThing, Health)?.current).toBe(99)

    link.close()
    destroyWorld(host)
    destroyWorld(joiner)
  })
})

describe('leaveWorld — graceful disconnect + TransientOnDisconnect cleanup', () => {
  it("sweeps the leaving user's transient-tagged entities when no peers remain", async () => {
    const host = createWorld({ agent: createAnonAgent('cleanup-host') })
    const joiner = createWorld({ agent: createAnonAgent('cleanup-joiner') })

    // Joiner registers a user + peer with its own DID
    const joinerUser = createUser(joiner, { did: joiner.network.localAgent.did, uid: 'user:joiner' })
    createPeer(joiner, { user: joinerUser, peerId: 'p1', uid: 'peer:joiner-p1', asLocal: true })

    // Host also has a record of the joiner user (replicated via authored events
    // in real life; here we set up directly for the test)
    const hostJoinerUser = createUser(host, { did: joiner.network.localAgent.did, uid: 'user:joiner' })

    // Host creates an avatar OWNED BY the joiner user, tagged TransientOnDisconnect
    const avatar = createEntity(host)
    setUID(host, avatar, 'avatar:joiner', { parent: createNamedEntity(host, 'scene:cleanup') })
    setOwner(host, avatar, hostJoinerUser)
    setComponent(host, avatar, TransientOnDisconnect, {})

    // Connect
    const link = createMemoryTransport()
    const [{ connection: hostConn }] = await Promise.all([
      joinWorld(host, { endpoint: link.a }),
      joinWorld(joiner, { endpoint: link.b })
    ])

    // Pre-leave: avatar exists on host
    expect(hasComponent(host, avatar, TransientOnDisconnect)).toBe(true)

    // Joiner leaves
    await leaveWorld(joiner, joiner.network.connections.values().next().value!)
    await flushAsync()

    // Host received the leave signal → swept the joiner's transient entities
    expect(hasComponent(host, avatar, TransientOnDisconnect)).toBe(false)

    void hostConn
    destroyWorld(host)
    destroyWorld(joiner)
  })

  it('does NOT sweep when the user has another live peer connection', async () => {
    const host = createWorld({ agent: createAnonAgent('multi-host') })
    const joinerA = createWorld({ agent: createAnonAgent('multi-A') })
    const joinerB = createWorld({ agent: createAnonAgent('multi-A') }) // same DID — second device

    // Force agent DIDs to match (same user, two devices)
    const userDID = 'did:test:multi-user'
    ;(joinerA.network.localAgent as { did: string }).did = userDID
    ;(joinerB.network.localAgent as { did: string }).did = userDID

    // Host knows the user + the avatar
    const user = createUser(host, { did: userDID, uid: 'user:multi' })
    const avatar = createEntity(host)
    setUID(host, avatar, 'avatar:multi', { parent: createNamedEntity(host, 'scene:multi') })
    setOwner(host, avatar, user)
    setComponent(host, avatar, TransientOnDisconnect, {})

    const link1 = createMemoryTransport()
    const link2 = createMemoryTransport()
    await Promise.all([joinWorld(host, { endpoint: link1.a }), joinWorld(joinerA, { endpoint: link1.b })])
    await Promise.all([joinWorld(host, { endpoint: link2.a }), joinWorld(joinerB, { endpoint: link2.b })])

    // Joiner A leaves
    await leaveWorld(joinerA, joinerA.network.connections.values().next().value!)
    await flushAsync()

    // Avatar should SURVIVE because joiner B still connected for the same user
    expect(hasComponent(host, avatar, TransientOnDisconnect)).toBe(true)

    // Now joiner B leaves too
    await leaveWorld(joinerB, joinerB.network.connections.values().next().value!)
    await flushAsync()

    // Now the avatar is swept
    expect(hasComponent(host, avatar, TransientOnDisconnect)).toBe(false)

    destroyWorld(host)
    destroyWorld(joinerA)
    destroyWorld(joinerB)
  })
})

describe('Sanity: applyAuthoredEnvelope works alongside lifecycle', () => {
  it('a joined world still accepts direct envelope applies (for tests)', async () => {
    const host = createWorld({ agent: createAnonAgent('sanity') })
    const peer = createWorld({ agent: createAnonAgent('sanity-peer') })
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
