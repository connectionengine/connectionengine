/**
 * Ownership + Authority.
 *
 * OwnedBy → user (not transferable; preserves provenance).
 * AuthoritativeFor → peer (transferable; this is how authority migrates
 *                          between a user's devices, or hands off to another
 *                          user's peer for host migration).
 *
 * Authority is an ECS-native relation. Transferring it is just removing the
 * old AuthoritativeFor pair and adding a new one — replicated as authored
 * mutations so all peers converge.
 *
 * Maps to canonical doc §3.18.
 */

import { defineRelation, getRelationTargets, addRelation, removeRelation } from '../ecs/relation'
import { getEntityPath } from './identity'
import type { Entity, World } from '../ecs/world'

export const OwnedBy = defineRelation({
  name: 'OwnedBy',
  exclusive: true,
  mutationCategory: 'authored'
})

export const AuthoritativeFor = defineRelation({
  name: 'AuthoritativeFor',
  exclusive: true,
  mutationCategory: 'authored'
})

// ── Ownership ────────────────────────────────────────────────────────────────-

export const setOwner = (world: World, entity: Entity, user: Entity): void => {
  addRelation(world, entity, OwnedBy, user)
}

export const getOwner = (world: World, entity: Entity): Entity | undefined =>
  getRelationTargets(world, entity, OwnedBy)[0]

// ── Authority ─────────────────────────────────────────────────────────────────

export interface AuthorityRequestResult {
  status: 'granted' | 'denied' | 'pending'
  reason?: string
}

/** Set authority directly (used by owner / host / capability holder). */
export const setAuthority = (world: World, entity: Entity, peer: Entity): void => {
  const current = getRelationTargets(world, entity, AuthoritativeFor)[0]
  if (current === peer) return
  if (current !== undefined) removeRelation(world, entity, AuthoritativeFor, current)
  addRelation(world, entity, AuthoritativeFor, peer)
}

export const getAuthority = (world: World, entity: Entity): Entity | undefined =>
  getRelationTargets(world, entity, AuthoritativeFor)[0]

/**
 * Transfer authority of an entity to a new peer. Only valid if the local peer
 * is either the entity's owner-user-peer or already holds authority. Replicates
 * via the authored pipeline.
 */
export const transferAuthority = (world: World, entity: Entity, newPeer: Entity): void => {
  setAuthority(world, entity, newPeer)
  world.trace.emit({
    kind: 'authority.transfer',
    ts: world.clock.now(),
    entity,
    detail: { newPeer, newPeerPath: getEntityPath(world, newPeer) }
  })
}

/**
 * Request authority. In this foundational layer the request immediately
 * resolves locally — higher layers can interpose async validation. The result
 * matches the spec's protocol shape so callers can be written against it.
 */
export const requestAuthority = async (
  world: World,
  entity: Entity,
  requester: Entity
): Promise<AuthorityRequestResult> => {
  world.trace.emit({
    kind: 'authority.request',
    ts: world.clock.now(),
    entity,
    detail: { requester, requesterPath: getEntityPath(world, requester) }
  })
  // Default policy: owner's user-peer auto-grants; otherwise denies until
  // governance hooks intervene.
  const owner = getOwner(world, entity)
  if (owner === undefined) {
    // No owner → first requester wins
    setAuthority(world, entity, requester)
    return { status: 'granted' }
  }
  // Check requester is one of the owner's peers (BelongsTo user = owner)
  const requesterUser = world.parentOf.get(requester)
  if (requesterUser === owner) {
    setAuthority(world, entity, requester)
    return { status: 'granted' }
  }
  return { status: 'denied', reason: "requester is not the owner-user's peer" }
}

/**
 * Auto-recover authority when the current holder disconnects.
 * Owner's lowest-id peer takes over.
 */
export const recoverAuthority = (world: World, entity: Entity, disconnectedPeer: Entity): void => {
  const current = getAuthority(world, entity)
  if (current !== disconnectedPeer) return
  const owner = getOwner(world, entity)
  if (owner === undefined) return
  // Find owner's peers by parentOf reverse lookup
  let lowest: Entity | undefined
  for (const [peerEntity, parent] of world.parentOf) {
    if (parent !== owner) continue
    if (peerEntity === disconnectedPeer) continue
    if (lowest === undefined || peerEntity < lowest) lowest = peerEntity
  }
  if (lowest !== undefined) setAuthority(world, entity, lowest)
}
