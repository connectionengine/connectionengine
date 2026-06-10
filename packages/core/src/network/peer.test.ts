import { describe, expect, it } from 'vitest'
import { createAnonAgent, createWorld, destroyWorld } from '../ecs/world'
import { createEngine } from '../ecs/engine'
import { createPeer, createUser, findUserByDID, getPeersForUser, PeerComponent, UserComponent } from './peer'
import { getComponent, hasComponent } from '../ecs/component'
import { getParent } from '../ecs/entity'

const mkWorld = () => createWorld({ engine: createEngine(), agent: createAnonAgent('test') })
const did = (name: string): string => `did:test:${name}`

describe('User + Peer', () => {
  it('createUser registers a user entity with did + displayName', () => {
    const world = mkWorld()
    const user = createUser(world, { did: did('alice'), displayName: 'Alice' })
    expect(hasComponent(world, user, UserComponent)).toBe(true)
    expect(getComponent(world, user, UserComponent)).toMatchObject({ did: did('alice'), displayName: 'Alice' })
    destroyWorld(world)
  })

  it('createUser is idempotent on DID', () => {
    const world = mkWorld()
    const a = createUser(world, { did: did('alice') })
    const b = createUser(world, { did: did('alice'), displayName: 'Different' })
    expect(a).toBe(b)
    destroyWorld(world)
  })

  it('findUserByDID locates registered users', () => {
    const world = mkWorld()
    const a = createUser(world, { did: did('a') })
    const b = createUser(world, { did: did('b') })
    expect(findUserByDID(world, did('a'))).toBe(a)
    expect(findUserByDID(world, did('b'))).toBe(b)
    expect(findUserByDID(world, 'did:test:nope')).toBeUndefined()
    destroyWorld(world)
  })

  it('createPeer attaches PeerComponent and BelongsTo user', () => {
    const world = mkWorld()
    const user = createUser(world, { did: did('u') })
    const peer = createPeer(world, { user, peerId: 'peer-1' })
    expect(getComponent(world, peer, PeerComponent)).toMatchObject({ peerId: 'peer-1', latency: 0 })
    expect(getParent(world, peer)).toBe(user)
    destroyWorld(world)
  })

  it('asLocal sets world.localPeer', () => {
    const world = mkWorld()
    const user = createUser(world, { did: did('u') })
    const peer = createPeer(world, { user, asLocal: true })
    expect(world.localPeer).toBe(peer)
    destroyWorld(world)
  })

  it('getPeersForUser returns all peers of a user', () => {
    const world = mkWorld()
    const user = createUser(world, { did: did('u'), uid: 'user:multi' })
    const p1 = createPeer(world, { user, peerId: 'p1' })
    const p2 = createPeer(world, { user, peerId: 'p2' })
    const otherUser = createUser(world, { did: did('other'), uid: 'user:other' })
    createPeer(world, { user: otherUser, peerId: 'p3' })
    const peers = getPeersForUser(world, user)
    expect(peers.sort()).toEqual([p1, p2].sort())
    destroyWorld(world)
  })
})
