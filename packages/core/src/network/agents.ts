/**
 * Component definitions for User, Peer, and the presence tag, plus the lookup
 * helpers.
 *
 * This module splits away from `peer.ts`, which holds the factory helpers. The
 * split lets `authority.ts` read user DIDs without an import of the factories,
 * and keeps the network-layer modules free of cycles. The layers run downward:
 *
 *     agents     (no dependency inside network/)
 *        ↑
 *     authority  (imports agents for getUserDID, defines OwnedBy and
 *                 AuthoritativeFor)
 *        ↑
 *     peer       (imports both — createUser and createPeer attach the
 *                 components and the relations)
 */

import { Schema } from '../schema'
import { defineComponent, getComponent, hasComponent } from '../ecs/component'
import { BelongsTo } from '../ecs/entity'
import { query } from '../ecs/query'
import type { Entity, World } from '../ecs/world'

/** Opaque DID string. The engine treats it as an arbitrary identifier. */
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

/**
 * Present on a peer entity for as long as this world holds a live connection to
 * it. Absent means disconnected.
 *
 * Connectedness is a **fact about this peer**, not a procedure to run at every
 * point a connection might end. Writing it on connect and removing it on
 * disconnect turns "clean up after a departed peer" from something four call
 * sites must remember into something an observer derives. See
 * `watchDisconnects` in `network/presence.ts`.
 *
 * `sync: false`, because it is a local observation rather than shared truth.
 * Alice seeing Bob connected says nothing about whether Carol can reach him, so
 * replicating it would assert something no other peer can verify.
 */
export const ConnectedTo = defineComponent({
  id: 'ConnectedTo',
  label: 'ConnectedTo',
  sync: false,
  schema: Schema.Object({
    networkId: Schema.String({ default: '' })
  })
})

// ── Lookups ───────────────────────────────────────────────────────────────────

/** Find a user entity by its DID. The scan is linear, which is acceptable
 *  because the user count stays small. */
export const findUserByDID = (world: World, did: string): Entity | undefined => {
  for (const entity of query(world, [UserComponent])) {
    const value = getComponent(world, entity, UserComponent) as { did?: string } | undefined
    if (value?.did === did) return entity
  }
  return undefined
}

/** Get the DID of a user entity. The function returns undefined when the entity
 *  carries none. */
export const getUserDID = (world: World, user: Entity): string | undefined => {
  const value = getComponent(world, user, UserComponent) as { did?: string } | undefined
  return value?.did
}

/** Find a peer entity by its peerId, under one specific user. The scan is linear. */
export const findPeerByIdForUser = (world: World, user: Entity, peerId: string): Entity | undefined => {
  for (const entity of query(world, [PeerComponent])) {
    if (BelongsTo.indexFor(world.engine).get(entity) !== user) continue
    const value = getComponent(world, entity, PeerComponent) as { peerId?: string } | undefined
    if (value?.peerId === peerId) return entity
  }
  return undefined
}

/** Get every peer that belongs to a user. */
export const getPeersForUser = (world: World, user: Entity): Entity[] => {
  const peers: Entity[] = []
  for (const entity of query(world, [PeerComponent])) {
    if (BelongsTo.indexFor(world.engine).get(entity) === user) peers.push(entity)
  }
  return peers
}

/** Is this world holding a live connection to `peer`? */
export const isPeerConnected = (world: World, peer: Entity): boolean => hasComponent(world, peer, ConnectedTo)

/** Every peer this world currently holds a connection to. */
export const connectedPeers = (world: World): readonly Entity[] => query(world, [ConnectedTo])
