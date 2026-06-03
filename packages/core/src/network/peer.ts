/**
 * User + Peer entities, identity wiring.
 *
 * A User is a person (one DID, many devices). A Peer is one engine instance
 * (one device / browser tab / server process). Peer BelongsTo User.
 *
 * Both are normal entities — nothing special about them at the engine layer
 * beyond two built-in component types and the identity convention. Authority
 * targets Peer; Ownership targets User (see authority.ts).
 *
 * Maps to canonical doc §3.17.
 */

import { Schema } from '../schema'
import { componentEntities, defineComponent, getComponent, setComponent } from '../ecs/component'
import { BelongsTo, createNamedEntity, setUID } from './identity'
import { addRelation } from '../ecs/relation'
import type { Entity, World } from '../ecs/world'

/** Opaque DID string — engine treats it as an arbitrary identifier. */
export type DID = string
import { createEntity } from '../ecs/entity'

// ── Built-in components ───────────────────────────────────────────────────────

export const UserComponent = defineComponent({
  id: 'User',
  label: 'User',
  mutationCategory: 'authored',
  schema: Schema.Object({
    did: Schema.String({ default: '' }),
    displayName: Schema.String({ default: '' })
  })
})

export const PeerComponent = defineComponent({
  id: 'Peer',
  label: 'Peer',
  mutationCategory: 'authored',
  schema: Schema.Object({
    peerId: Schema.String({ default: '' }),
    latency: Schema.Number({ default: 0 })
  })
})

// ── createUser ────────────────────────────────────────────────────────────────

export interface CreateUserOptions {
  did: DID | string
  displayName?: string
  uid?: string
}

/**
 * Create (or resolve) a user entity for the given DID. Idempotent on DID:
 * if a user entity with this DID already exists in the world, returns it.
 */
export const createUser = (world: World, options: CreateUserOptions): Entity => {
  const existing = findUserByDID(world, options.did)
  if (existing !== undefined) return existing
  const uid = options.uid ?? `user:${options.did}`
  const entity = createNamedEntity(world, uid)
  setComponent(world, entity, UserComponent, { did: options.did, displayName: options.displayName ?? '' })
  return entity
}

/** Find a user entity by DID. Linear scan — acceptable since user count is small. */
export const findUserByDID = (world: World, did: string): Entity | undefined => {
  for (const entity of componentEntities(world, UserComponent)) {
    const value = getComponent(world, entity, UserComponent) as { did?: string } | undefined
    if (value?.did === did) return entity
  }
  return undefined
}

// ── createPeer ────────────────────────────────────────────────────────────────

export interface CreatePeerOptions {
  user: Entity
  peerId?: string
  uid?: string
  /** If true, sets world.network.localPeer to this entity. */
  asLocal?: boolean
}

/**
 * Create a peer entity that BelongsTo a user. One device/tab/process =
 * one peer entity. The peerId defaults to a random UUID-shaped string.
 */
export const createPeer = (world: World, options: CreatePeerOptions): Entity => {
  const peerId = options.peerId ?? randomPeerId()
  const uid = options.uid ?? `peer:${peerId}`
  const entity = createEntity(world)
  setUID(world, entity, uid, { parent: options.user })
  setComponent(world, entity, PeerComponent, { peerId, latency: 0 })
  // BelongsTo(user) is already set by setUID's parent handling
  // (it adds the BelongsTo relation under the hood).
  void addRelation // satisfies lint
  if (options.asLocal) world.network.localPeer = entity
  return entity
}

const randomPeerId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // Fallback for older Node without crypto.randomUUID
  let s = ''
  for (let i = 0; i < 16; i++)
    s += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

// ── Peer queries ──────────────────────────────────────────────────────────────

/** Get all peers belonging to a user. */
export const getPeersForUser = (world: World, user: Entity): Entity[] => {
  const peers: Entity[] = []
  for (const entity of componentEntities(world, PeerComponent)) {
    if (world.parentOf.get(entity) === user) peers.push(entity)
  }
  return peers
}

/** Re-export BelongsTo from identity so users can construct it without a second import. */
export { BelongsTo }
