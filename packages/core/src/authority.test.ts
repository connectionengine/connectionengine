import { describe, expect, it } from 'vitest'
import { createWorld, destroyWorld } from './world'
import { createPeer, createUser } from './peer'
import { keyPairFromSeed } from './did'
import {
  AuthoritativeFor,
  OwnedBy,
  getAuthority,
  getOwner,
  recoverAuthority,
  requestAuthority,
  setAuthority,
  setOwner,
  transferAuthority
} from './authority'
import { createEntity } from './entity'

const mkWorld = () => {
  const world = createWorld()
  const did = keyPairFromSeed('owner').did
  const user = createUser(world, { did, uid: 'user:owner' })
  const peerA = createPeer(world, { user, peerId: 'a', uid: 'peer:a' })
  const peerB = createPeer(world, { user, peerId: 'b', uid: 'peer:b' })
  return { world, user, peerA, peerB }
}

describe('Ownership', () => {
  it('setOwner / getOwner via OwnedBy relation', () => {
    const { world, user } = mkWorld()
    const e = createEntity(world)
    setOwner(world, e, user)
    expect(getOwner(world, e)).toBe(user)
    expect(OwnedBy.exclusive).toBe(true)
    destroyWorld(world)
  })
})

describe('Authority', () => {
  it('setAuthority assigns AuthoritativeFor peer', () => {
    const { world, peerA } = mkWorld()
    const e = createEntity(world)
    setAuthority(world, e, peerA)
    expect(getAuthority(world, e)).toBe(peerA)
    expect(AuthoritativeFor.exclusive).toBe(true)
    destroyWorld(world)
  })

  it('transferAuthority replaces current holder', () => {
    const { world, peerA, peerB } = mkWorld()
    const e = createEntity(world)
    setAuthority(world, e, peerA)
    transferAuthority(world, e, peerB)
    expect(getAuthority(world, e)).toBe(peerB)
    destroyWorld(world)
  })

  it('emits authority.transfer trace event', () => {
    const { world, peerA, peerB } = mkWorld()
    const e = createEntity(world)
    setAuthority(world, e, peerA)
    transferAuthority(world, e, peerB)
    const transfers = world.trace.byKind('authority.transfer')
    expect(transfers.length).toBeGreaterThan(0)
    expect(transfers[transfers.length - 1]?.detail?.newPeer).toBe(peerB)
    destroyWorld(world)
  })

  it("requestAuthority grants when owner-user matches requester's user", async () => {
    const { world, user, peerA } = mkWorld()
    const e = createEntity(world)
    setOwner(world, e, user)
    const result = await requestAuthority(world, e, peerA)
    expect(result.status).toBe('granted')
    expect(getAuthority(world, e)).toBe(peerA)
    destroyWorld(world)
  })

  it('requestAuthority denies when requester belongs to a different user', async () => {
    const { world, user } = mkWorld()
    const otherUser = createUser(world, { did: keyPairFromSeed('rogue').did, uid: 'user:rogue' })
    const roguePeer = createPeer(world, { user: otherUser, peerId: 'rogue-p', uid: 'peer:rogue' })
    const e = createEntity(world)
    setOwner(world, e, user)
    const result = await requestAuthority(world, e, roguePeer)
    expect(result.status).toBe('denied')
    expect(getAuthority(world, e)).toBeUndefined()
    destroyWorld(world)
  })

  it("recoverAuthority hands over to owner's lowest-id remaining peer on disconnect", () => {
    const { world, user, peerA, peerB } = mkWorld()
    const e = createEntity(world)
    setOwner(world, e, user)
    setAuthority(world, e, peerB)
    recoverAuthority(world, e, peerB)
    expect(getAuthority(world, e)).toBe(peerA)
    destroyWorld(world)
  })

  it('recoverAuthority is a noop when disconnected peer is not the current authority', () => {
    const { world, user, peerA, peerB } = mkWorld()
    const e = createEntity(world)
    setOwner(world, e, user)
    setAuthority(world, e, peerA)
    recoverAuthority(world, e, peerB)
    expect(getAuthority(world, e)).toBe(peerA)
    destroyWorld(world)
  })
})
