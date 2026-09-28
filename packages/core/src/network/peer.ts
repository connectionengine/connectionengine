/**
 * Factories for the User entity and the Peer entity.
 *
 * The component definitions and the lookup helpers live in `agents.ts`. That
 * split lets `authority.ts` read user DIDs without an import of the factory
 * functions here, which prevents an `authority → peer → authority` cycle.
 *
 * Import the components and the lookups from `agents.ts`, which defines them.
 * Do not mirror a list of their names here: the package barrel exports both
 * modules, so a caller outside core already has one import path, and a
 * hand-written list goes stale as `agents.ts` grows.
 */

import { setComponent } from '../ecs/component'
import { createEntity, setUID } from '../ecs/entity'
import { addRelation } from '../ecs/relation'
import { AuthoritativeFor, OwnedBy } from './authority'
import { PeerComponent, UserComponent, findUserByDID, type DID } from './agents'
import type { Entity, World } from '../ecs/world'

// ── createUser ────────────────────────────────────────────────────────────────

export interface CreateUserOptions {
  did: DID | string
  displayName?: string
  uid?: string
  /** When true, the factory sets world.localUser to this entity. */
  asLocal?: boolean
}

/**
 * Create a user entity for the given DID, or resolve the existing one. The
 * function is idempotent on the DID. A user is self-owned, through
 * `OwnedBy(self)`, which anchors the owner chain for everything else in the
 * world.
 */
export const createUser = (world: World, options: CreateUserOptions): Entity => {
  const existing = findUserByDID(world, options.did)
  if (existing !== undefined) {
    if (options.asLocal) world.localUser = existing
    return existing
  }
  const uid = options.uid ?? `user:${options.did}`
  const entity = createEntity(world)
  setUID(world, entity, uid)
  setComponent(world, entity, UserComponent, { did: options.did, displayName: options.displayName ?? '' })
  OwnedBy.set(world, entity, entity)
  if (options.asLocal) world.localUser = entity
  return entity
}

// ── createPeer ────────────────────────────────────────────────────────────────

export interface CreatePeerOptions {
  user: Entity
  peerId?: string
  uid?: string
  /** When true, the factory sets world.localPeer. It also sets world.localUser
   *  if no value is set there yet. */
  asLocal?: boolean
}

/**
 * Create a peer entity that BelongsTo a user. Each device, tab, or process maps
 * to exactly one peer entity. Its user owns it, and it holds authority over its
 * own state.
 *
 * With `asLocal: true`, the function sets `world.localPeer` AND
 * `world.localUser`, if no value is set there yet. This helps in the common
 * single-user case, where `createPeer` is the only call that passes `asLocal`.
 */
export const createPeer = (world: World, options: CreatePeerOptions): Entity => {
  const peerId = options.peerId ?? randomPeerId()
  const uid = options.uid ?? `peer:${peerId}`
  const entity = createEntity(world)
  setUID(world, entity, uid, { parent: options.user })
  setComponent(world, entity, PeerComponent, { peerId, latency: 0 })
  OwnedBy.set(world, entity, options.user)
  addRelation(world, entity, AuthoritativeFor, entity)
  if (options.asLocal) {
    world.localPeer = entity
    if (world.localUser === undefined) world.localUser = options.user
  }
  return entity
}

const randomPeerId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  let s = ''
  for (let i = 0; i < 16; i++)
    s += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}
