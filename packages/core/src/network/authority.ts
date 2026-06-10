/**
 * Ownership + Authority — networked-entity primitives.
 *
 * Lives in `network/` because owner and authority are wire concerns — they
 * only matter when entities replicate across peers. The pure ECS layer
 * (`createEntity`) knows nothing about them.
 *
 * Networked entities are created via `spawnPrefab` (in `network/prefab.ts`),
 * which assigns `OwnedBy` + `AuthoritativeFor` alongside the UID. This module
 * carries the relations themselves plus the transfer / recovery / standing-check
 * machinery.
 *
 * Semantics:
 *   - `OwnedBy(user)`            — permanent provenance. Set once, never moves.
 *   - `AuthoritativeFor(peer)`   — transferable runtime authority. The peer
 *                                   currently writing this entity's state.
 *
 * Transfers are gated end-to-end:
 *   - **Sender-side**: `setAuthority` / `transferAuthority` throw unless the
 *     local peer has standing (current authority OR a peer of the owner-user).
 *   - **Receive-side**: `applyAuthoredEnvelope` (in `network/mutation.ts`) runs
 *     the equivalent check on every incoming `AuthoritativeFor` mutation. The
 *     event's author DID must match either the owner-user's DID or the
 *     current authority's user-DID. Failed events are rejected, never applied.
 */

import { defineRelation, getRelationTargets, addRelation, removeRelation } from '../ecs/relation'
import { parentOfFor, resolveEntityPath } from '../ecs/entity'
import { getUserDID } from './agents'
import type { Entity, World, AuthoredEvent } from '../ecs/world'

export const OwnedBy = defineRelation({
  name: 'OwnedBy',
  exclusive: true
})

export const AuthoritativeFor = defineRelation({
  name: 'AuthoritativeFor',
  exclusive: true
})

// ── Ownership ────────────────────────────────────────────────────────────────-

/**
 * Direct owner assignment. Rare — owner is normally set once via `spawnPrefab`.
 * Used by bootstrap helpers (`createUser` self-owns; `createPeer` owns under
 * its user) and by the receive path when materialising remote identities.
 */
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

/**
 * Does the local peer have standing to change `entity`'s authority? Returns
 * true iff the local peer is the current authority holder OR belongs to the
 * same user as the entity's owner (any of the owner's peers can authorise a
 * transfer).
 */
export const canChangeAuthority = (world: World, entity: Entity): boolean => {
  const localPeer = world.localPeer
  if (localPeer === undefined) return false
  const current = getAuthority(world, entity)
  if (current === localPeer) return true
  const owner = getOwner(world, entity)
  if (owner === undefined) return false
  return parentOfFor(world.engine).get(localPeer) === owner
}

/**
 * Set authority. Sender-gated by `canChangeAuthority`. Pass `{ unchecked:
 * true }` only from bootstrap helpers (`createPeer` self-authority, the
 * receive path's remote-peer materialisation, `recoverAuthority`).
 */
export const setAuthority = (
  world: World,
  entity: Entity,
  peer: Entity,
  options: { unchecked?: boolean } = {}
): void => {
  const current = getRelationTargets(world, entity, AuthoritativeFor)[0]
  if (current === peer) return
  if (!options.unchecked && !canChangeAuthority(world, entity)) {
    throw new Error(
      `setAuthority: local peer (${world.localPeer ?? 'unset'}) lacks standing to change authority on entity ${entity}`
    )
  }
  if (current !== undefined) removeRelation(world, entity, AuthoritativeFor, current)
  addRelation(world, entity, AuthoritativeFor, peer)
}

export const getAuthority = (world: World, entity: Entity): Entity | undefined =>
  getRelationTargets(world, entity, AuthoritativeFor)[0]

/**
 * Transfer authority of `entity` to `newPeer`. Sender-gated: throws if the
 * local peer lacks standing. The two relation writes (remove old, add new)
 * replicate via the authored pipeline; the receive-side gate in
 * `network/mutation.ts` enforces the same check on every peer that receives
 * the events.
 */
export const transferAuthority = (world: World, entity: Entity, newPeer: Entity): void => {
  setAuthority(world, entity, newPeer)
}

/**
 * Request authority. Default policy: owner's user-peer auto-grants; everyone
 * else denies. An owner-less entity is an invariant violation (every
 * `spawnPrefab` sets one) — denied rather than first-write-wins.
 */
export const requestAuthority = async (
  world: World,
  entity: Entity,
  requester: Entity
): Promise<AuthorityRequestResult> => {
  const owner = getOwner(world, entity)
  if (owner === undefined) {
    return { status: 'denied', reason: 'entity has no owner — invariant violation' }
  }
  const requesterUser = parentOfFor(world.engine).get(requester)
  if (requesterUser === owner) {
    setAuthority(world, entity, requester, { unchecked: true })
    return { status: 'granted' }
  }
  return { status: 'denied', reason: "requester is not the owner-user's peer" }
}

/**
 * Reassign authority when the current holder has disconnected. Picks the
 * lowest-id remaining peer of the owner-user; falls back to `world.localPeer`
 * if no peer of the owner remains locally known (last-resort host migration).
 *
 * Wired into `sweepDisconnectedPeer` so it runs automatically on disconnect.
 */
// ── Receive-side standing check ───────────────────────────────────────────────-

/**
 * Verify the author of an `AuthoritativeFor` mutation has standing — either
 * they are the owner-user, or they are the current authority's user. Returns
 * `undefined` when the author has standing, or a human-readable reason
 * string when it should be rejected. Returns `undefined` immediately for any
 * predicate other than `AuthoritativeFor`.
 *
 * Called inline by `network/mutation.ts` `applyAuthoredEnvelope` — both live
 * in `network/`, so this is a direct named import, not a runtime hook.
 *
 * Evaluated against the world's *current* state at receipt — replayed events
 * apply in arrival order so chronology stays consistent.
 */
export const checkAuthorityChangeStanding = (world: World, event: AuthoredEvent): string | undefined => {
  if (event.predicate !== AuthoritativeFor.name) return undefined
  const entity = resolveEntityPath(world, event.entityPath)
  if (entity === undefined) return 'subject entity does not exist locally'
  const owner = getOwner(world, entity)
  if (owner === undefined) return 'subject entity has no owner — invariant violation'
  const ownerDID = getUserDID(world, owner)
  if (ownerDID !== undefined && event.author === ownerDID) return undefined
  const current = getAuthority(world, entity)
  if (current !== undefined) {
    const authorityUser = parentOfFor(world.engine).get(current)
    if (authorityUser !== undefined) {
      const authorityDID = getUserDID(world, authorityUser)
      if (authorityDID !== undefined && event.author === authorityDID) return undefined
    }
  }
  return `author '${event.author}' is neither owner-user nor current authority's user`
}

// ── recoverAuthority ──────────────────────────────────────────────────────────

export const recoverAuthority = (world: World, entity: Entity, disconnectedPeer: Entity): void => {
  const current = getAuthority(world, entity)
  if (current !== disconnectedPeer) return
  const owner = getOwner(world, entity)
  if (owner === undefined) return
  let lowest: Entity | undefined
  for (const [peerEntity, parent] of parentOfFor(world.engine)) {
    if (parent !== owner) continue
    if (peerEntity === disconnectedPeer) continue
    if (lowest === undefined || peerEntity < lowest) lowest = peerEntity
  }
  const successor = lowest ?? world.localPeer
  if (successor === undefined || successor === disconnectedPeer) return
  setAuthority(world, entity, successor, { unchecked: true })
}
