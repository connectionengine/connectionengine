import { describe, expect, it } from 'vitest'
import { createEngine } from '../ecs/engine'
import { createAnonAgent, createWorld, destroyWorld } from '../ecs/world'
import { createPeer, createUser } from './peer'
import {
  AuthoritativeFor,
  OwnedBy,
  canChangeAuthority,
  getAuthority,
  getOwner,
  recoverAuthority,
  requestAuthority,
  setAuthority,
  transferAuthority
} from './authority'
import { spawnPrefab } from './prefab'

const mkWorld = () => {
  const world = createWorld({ engine: createEngine(), agent: createAnonAgent('owner') })
  const user = createUser(world, { did: 'did:test:owner', uid: 'user:owner', asLocal: true })
  const peerA = createPeer(world, { user, peerId: 'a', uid: 'peer:a', asLocal: true })
  const peerB = createPeer(world, { user, peerId: 'b', uid: 'peer:b' })
  return { world, user, peerA, peerB }
}

describe('Ownership', () => {
  it('spawnPrefab defaults owner to world.localUser', () => {
    const { world, user } = mkWorld()
    const e = spawnPrefab(world, 'thing-1')
    expect(getOwner(world, e)).toBe(user)
    expect(OwnedBy.exclusive).toBe(true)
    destroyWorld(world)
  })

  it('explicit owner option overrides the default', () => {
    const { world, user } = mkWorld()
    const otherUser = createUser(world, { did: 'did:test:other', uid: 'user:other' })
    const e = spawnPrefab(world, 'thing-2', { owner: otherUser })
    expect(getOwner(world, e)).toBe(otherUser)
    expect(getOwner(world, e)).not.toBe(user)
    destroyWorld(world)
  })

  it('spawnPrefab throws when no owner can be determined', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent('noowner') })
    expect(() => spawnPrefab(world, 'thing')).toThrow(/no owner provided/i)
    destroyWorld(world)
  })

  it('User entities are self-owned', () => {
    const { world, user } = mkWorld()
    expect(getOwner(world, user)).toBe(user)
    destroyWorld(world)
  })

  it('Peer entities are owned by their user and self-authoritative', () => {
    const { world, user, peerA } = mkWorld()
    expect(getOwner(world, peerA)).toBe(user)
    expect(getAuthority(world, peerA)).toBe(peerA)
    destroyWorld(world)
  })
})

describe('Authority', () => {
  it('spawnPrefab defaults authority to world.localPeer', () => {
    const { world, peerA } = mkWorld()
    const e = spawnPrefab(world, 'thing-3')
    expect(getAuthority(world, e)).toBe(peerA)
    expect(AuthoritativeFor.exclusive).toBe(true)
    destroyWorld(world)
  })

  it('transferAuthority replaces current holder when sender has standing', () => {
    const { world, peerB } = mkWorld()
    const e = spawnPrefab(world, 'thing-4') // authority=peerA (localPeer)
    transferAuthority(world, e, peerB)
    expect(getAuthority(world, e)).toBe(peerB)
    destroyWorld(world)
  })

  it('canChangeAuthority is true when local peer is current authority', () => {
    const { world } = mkWorld()
    const e = spawnPrefab(world, 'thing-6')
    expect(canChangeAuthority(world, e)).toBe(true)
    destroyWorld(world)
  })

  it("canChangeAuthority is true when local peer is one of owner's peers", () => {
    const { world, peerB } = mkWorld()
    const e = spawnPrefab(world, 'thing-7')
    transferAuthority(world, e, peerB)
    // localPeer is peerA, peerB now holds authority. peerA is still owner's peer.
    expect(canChangeAuthority(world, e)).toBe(true)
    destroyWorld(world)
  })

  it('setAuthority without standing throws', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent('alice') })
    const aliceUser = createUser(world, { did: 'did:test:alice', uid: 'user:alice', asLocal: true })
    const alicePeer = createPeer(world, { user: aliceUser, peerId: 'a', uid: 'peer:alice', asLocal: true })
    const bobUser = createUser(world, { did: 'did:test:bob', uid: 'user:bob' })
    const bobPeer = createPeer(world, { user: bobUser, peerId: 'b', uid: 'peer:bob' })
    const e = spawnPrefab(world, 'bob-thing', { owner: bobUser, authority: bobPeer })
    expect(() => setAuthority(world, e, alicePeer)).toThrow(/lacks standing/)
    expect(getAuthority(world, e)).toBe(bobPeer)
    destroyWorld(world)
  })

  it("requestAuthority grants when owner-user matches requester's user", async () => {
    const { world, peerA } = mkWorld()
    const e = spawnPrefab(world, 'thing-8')
    const result = await requestAuthority(world, e, peerA)
    expect(result.status).toBe('granted')
    expect(getAuthority(world, e)).toBe(peerA)
    destroyWorld(world)
  })

  it('requestAuthority denies when requester belongs to a different user', async () => {
    const { world } = mkWorld()
    const otherUser = createUser(world, { did: 'did:test:rogue', uid: 'user:rogue' })
    const roguePeer = createPeer(world, { user: otherUser, peerId: 'rogue-p', uid: 'peer:rogue' })
    const e = spawnPrefab(world, 'thing-9')
    const result = await requestAuthority(world, e, roguePeer)
    expect(result.status).toBe('denied')
    destroyWorld(world)
  })

  it("recoverAuthority hands over to owner's lowest-id remaining peer on disconnect", () => {
    const { world, peerA, peerB } = mkWorld()
    const e = spawnPrefab(world, 'thing-10') // authority=peerA (localPeer)
    transferAuthority(world, e, peerB)
    recoverAuthority(world, e, peerB)
    expect(getAuthority(world, e)).toBe(peerA)
    destroyWorld(world)
  })

  it('recoverAuthority falls back to localPeer when no other peer of owner remains', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent('solo') })
    createUser(world, { did: 'did:test:solo', uid: 'user:solo', asLocal: true })
    const soloPeer = createPeer(world, { user: world.localUser!, peerId: 'p', uid: 'peer:solo', asLocal: true })
    const remoteUser = createUser(world, { did: 'did:test:remote', uid: 'user:remote' })
    const remotePeer = createPeer(world, { user: remoteUser, peerId: 'r', uid: 'peer:remote' })
    const e = spawnPrefab(world, 'remote-thing', { owner: remoteUser, authority: remotePeer })
    recoverAuthority(world, e, remotePeer)
    expect(getAuthority(world, e)).toBe(soloPeer)
    destroyWorld(world)
  })

  it('recoverAuthority is a noop when disconnected peer is not the current authority', () => {
    const { world, peerA, peerB } = mkWorld()
    const e = spawnPrefab(world, 'thing-11')
    recoverAuthority(world, e, peerB) // peerB isn't the holder
    expect(getAuthority(world, e)).toBe(peerA)
    destroyWorld(world)
  })
})
