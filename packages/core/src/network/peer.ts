/**
 * User + Peer entity factories.
 *
 * The component definitions and lookup helpers live in `agents.ts` so that
 * `authority.ts` can read user DIDs without importing the factory functions
 * here — preventing an `authority → peer → authority` cycle. This module
 * carries only the wire-identity bootstrap helpers.
 */

import { setComponent } from '../ecs/component'
import { BelongsTo, createEntity, setUID } from '../ecs/entity'
import { addRelation } from '../ecs/relation'
import { AuthoritativeFor, OwnedBy } from './authority'
import { PeerComponent, UserComponent, findUserByDID, type DID } from './agents'
import type { Entity, World } from '../ecs/world'

// Re-export the agent primitives for callers that just want one import path.
export { UserComponent, PeerComponent, findUserByDID, findPeerByIdForUser, getPeersForUser, getUserDID } from './agents'
export type { DID } from './agents'

// ── createUser ────────────────────────────────────────────────────────────────

export interface CreateUserOptions {
  did: DID | string
  displayName?: string
  uid?: string
  /** If true, sets world.localUser to this entity. */
  asLocal?: boolean
}

/**
 * Create (or resolve) a user entity for the given DID. Idempotent on DID.
 * Users are self-owned (`OwnedBy(self)`) — anchoring the owner chain for
 * everything else in the world.
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
  addRelation(world, entity, OwnedBy, entity)
  if (options.asLocal) world.localUser = entity
  return entity
}

// ── createPeer ────────────────────────────────────────────────────────────────

export interface CreatePeerOptions {
  user: Entity
  peerId?: string
  uid?: string
  /** If true, sets world.localPeer (and world.localUser if unset). */
  asLocal?: boolean
}

/**
 * Create a peer entity that BelongsTo a user. One device/tab/process =
 * one peer entity. Owned by its user, self-authoritative for its own state.
 *
 * When `asLocal: true`, also sets `world.localPeer` AND `world.localUser`
 * (if not already set) — convenience for the common single-user case where
 * createPeer is the only `asLocal` call.
 */
export const createPeer = (world: World, options: CreatePeerOptions): Entity => {
  const peerId = options.peerId ?? randomPeerId()
  const uid = options.uid ?? `peer:${peerId}`
  const entity = createEntity(world)
  setUID(world, entity, uid, { parent: options.user })
  setComponent(world, entity, PeerComponent, { peerId, latency: 0 })
  addRelation(world, entity, OwnedBy, options.user)
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

/** Re-export BelongsTo so users can construct it without a second import. */
export { BelongsTo }
