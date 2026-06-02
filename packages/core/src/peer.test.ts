import { describe, expect, it } from 'vitest'
import { createWorld, destroyWorld } from './world'
import { createPeer, createUser, findUserByDID, getPeersForUser, PeerComponent, UserComponent } from './peer'
import { keyPairFromSeed } from './did'
import { getComponent, hasComponent } from './component'
import { getParent } from './identity'

describe('User + Peer', () => {
  it('createUser registers a user entity with did + displayName', () => {
    const world = createWorld()
    const alice = keyPairFromSeed('alice')
    const user = createUser(world, { did: alice.did, displayName: 'Alice' })
    expect(hasComponent(world, user, UserComponent)).toBe(true)
    expect(getComponent(world, user, UserComponent)).toMatchObject({ did: alice.did, displayName: 'Alice' })
    destroyWorld(world)
  })

  it('createUser is idempotent on DID', () => {
    const world = createWorld()
    const did = keyPairFromSeed('alice').did
    const a = createUser(world, { did })
    const b = createUser(world, { did, displayName: 'Different' })
    expect(a).toBe(b)
    destroyWorld(world)
  })

  it('findUserByDID locates registered users', () => {
    const world = createWorld()
    const did1 = keyPairFromSeed('a').did
    const did2 = keyPairFromSeed('b').did
    const a = createUser(world, { did: did1 })
    const b = createUser(world, { did: did2 })
    expect(findUserByDID(world, did1)).toBe(a)
    expect(findUserByDID(world, did2)).toBe(b)
    expect(findUserByDID(world, 'did:key:znope')).toBeUndefined()
    destroyWorld(world)
  })

  it('createPeer attaches PeerComponent and BelongsTo user', () => {
    const world = createWorld()
    const user = createUser(world, { did: keyPairFromSeed('u').did })
    const peer = createPeer(world, { user, peerId: 'peer-1' })
    expect(getComponent(world, peer, PeerComponent)).toMatchObject({ peerId: 'peer-1', latency: 0 })
    expect(getParent(world, peer)).toBe(user)
    destroyWorld(world)
  })

  it('asLocal sets world.network.localPeer', () => {
    const world = createWorld()
    const user = createUser(world, { did: keyPairFromSeed('u').did })
    const peer = createPeer(world, { user, asLocal: true })
    expect(world.network.localPeer).toBe(peer)
    destroyWorld(world)
  })

  it('getPeersForUser returns all peers of a user', () => {
    const world = createWorld()
    const user = createUser(world, { did: keyPairFromSeed('u').did, uid: 'user:multi' })
    const p1 = createPeer(world, { user, peerId: 'p1' })
    const p2 = createPeer(world, { user, peerId: 'p2' })
    const otherUser = createUser(world, { did: keyPairFromSeed('other').did, uid: 'user:other' })
    createPeer(world, { user: otherUser, peerId: 'p3' })
    const peers = getPeersForUser(world, user)
    expect(peers.sort()).toEqual([p1, p2].sort())
    destroyWorld(world)
  })
})
