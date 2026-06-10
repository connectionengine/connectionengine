/**
 * User + Peer + presence-tag component definitions + lookup helpers.
 *
 * Split out from `peer.ts` (which carries the factory helpers) so that
 * `authority.ts` can read user DIDs without importing the factories — keeps
 * the network-layer modules free of cycles. Layering downward:
 *
 *     agents (no deps within network/)
 *        ↑
 *     authority (imports agents for getUserDID, defines OwnedBy/AuthoritativeFor)
 *        ↑
 *     peer       (imports both — createUser/createPeer wire components + relations)
 */

import { Schema } from '../schema'
import { defineComponent, getComponent } from '../ecs/component'
import { parentOfFor } from '../ecs/entity'
import { query } from '../ecs/query'
import type { Entity, World } from '../ecs/world'

/** Opaque DID string — engine treats it as an arbitrary identifier. */
export type DID = string

export const UserComponent = defineComponent({
  id: 'User',
  label: 'User',
  schema: Schema.Object({
    did: Schema.String({ default: '' }),
    displayName: Schema.String({ default: '' })
  })
})

export const PeerComponent = defineComponent({
  id: 'Peer',
  label: 'Peer',
  schema: Schema.Object({
    peerId: Schema.String({ default: '' }),
    latency: Schema.Number({ default: 0 })
  })
})

// ── Lookups ───────────────────────────────────────────────────────────────────

/** Find a user entity by DID. Linear scan — acceptable since user count is small. */
export const findUserByDID = (world: World, did: string): Entity | undefined => {
  for (const entity of query(world, [UserComponent])) {
    const value = getComponent(world, entity, UserComponent) as { did?: string } | undefined
    if (value?.did === did) return entity
  }
  return undefined
}

/** Get the DID of a user entity, or undefined if not present. */
export const getUserDID = (world: World, user: Entity): string | undefined => {
  const value = getComponent(world, user, UserComponent) as { did?: string } | undefined
  return value?.did
}

/** Find a peer entity by peerId under a specific user. Linear scan. */
export const findPeerByIdForUser = (world: World, user: Entity, peerId: string): Entity | undefined => {
  for (const entity of query(world, [PeerComponent])) {
    if (parentOfFor(world.engine).get(entity) !== user) continue
    const value = getComponent(world, entity, PeerComponent) as { peerId?: string } | undefined
    if (value?.peerId === peerId) return entity
  }
  return undefined
}

/** Get all peers belonging to a user. */
export const getPeersForUser = (world: World, user: Entity): Entity[] => {
  const peers: Entity[] = []
  for (const entity of query(world, [PeerComponent])) {
    if (parentOfFor(world.engine).get(entity) === user) peers.push(entity)
  }
  return peers
}
