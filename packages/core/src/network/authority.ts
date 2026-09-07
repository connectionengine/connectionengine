/**
 * Ownership and Authority — the primitives of a networked entity.
 *
 * They live in `network/`, because owner and authority are wire concerns. They
 * matter only when entities replicate across peers. The pure ECS layer, through
 * `createEntity`, knows nothing about them.
 *
 * `spawnPrefab`, in `network/prefab.ts`, creates a networked entity. It assigns
 * `OwnedBy` and `AuthoritativeFor` beside the UID. This module holds the
 * relations themselves, and the machinery for transfer, recovery, and the
 * standing check.
 *
 * Semantics:
 *   - `OwnedBy(user)`            — permanent provenance. Set once, and it never
 *                                  moves.
 *   - `AuthoritativeFor(peer)`   — transferable runtime authority. It names the
 *                                  peer that writes the state of this entity
 *                                  now.
 *
 * A gate guards each transfer end to end:
 *   - **Sender-side**: `setAuthority` and `transferAuthority` throw unless the
 *     local peer holds standing. Standing means the current authority, or a
 *     peer of the owner-user.
 *   - **Receive-side**: `applyAuthoredEnvelope`, in `network/mutation.ts`, runs
 *     the equivalent check on every incoming `AuthoritativeFor` mutation. The
 *     author DID of the event must match the DID of the owner-user, or the user
 *     DID of the current authority. A failed event is rejected, and never
 *     applied.
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
 * Direct owner assignment. Callers need it rarely, because `spawnPrefab`
 * normally sets the owner once. Two places use it. The bootstrap helpers use
 * it: `createUser` makes a user self-owned, and `createPeer` puts a peer under
 * its user. The receive path uses it when it materialises a remote identity.
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
 * Does the local peer hold standing to change the authority of `entity`? The
 * function returns true if and only if one of two conditions holds. The local
 * peer is the current authority holder. Or the local peer belongs to the same
 * user as the owner of the entity, because any peer of the owner can authorise
 * a transfer.
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
 * Set the authority. `canChangeAuthority` gates the sender side. Pass
 * `{ unchecked: true }` only from a bootstrap helper. Three of them use it:
 * the self-authority step of `createPeer`, the remote-peer materialisation on
 * the receive path, and `recoverAuthority`.
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
 * Transfer the authority of `entity` to `newPeer`. A sender-side gate applies,
 * so the function throws when the local peer lacks standing. The two relation
 * writes — remove the old target, add the new one — replicate through the
 * authored pipeline. The receive-side gate in `network/mutation.ts` then runs
 * the same check on every peer that receives those events.
 */
export const transferAuthority = (world: World, entity: Entity, newPeer: Entity): void => {
  setAuthority(world, entity, newPeer)
}

/**
 * Request the authority. The default policy has three rules. A peer of the
 * owner-user receives an automatic grant. Every other requester receives a
 * denial. An entity without an owner counts as an invariant violation, because
 * every `spawnPrefab` sets one, so the policy denies the request instead of
 * granting it to the first writer.
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

// ── Receive-side standing check ───────────────────────────────────────────────-

/**
 * Verify that the author of an `AuthoritativeFor` mutation holds standing. The
 * author must be the owner-user, or the user of the current authority. The
 * function returns `undefined` when the author holds standing. It returns a
 * human-readable reason string when the caller must reject the event. It
 * returns `undefined` immediately for every predicate other than
 * `AuthoritativeFor`.
 *
 * `applyAuthoredEnvelope` in `network/mutation.ts` calls it inline. Both
 * modules live in `network/`, so this is a direct named import rather than a
 * runtime hook.
 *
 * The check evaluates against the *current* state of the world at receipt.
 * Replayed events apply in arrival order, which keeps the chronology
 * consistent.
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

/**
 * Reassign the authority after the current holder disconnects. The function
 * selects the remaining peer of the owner-user with the lowest id. It falls
 * back to `world.localPeer` when it knows no remaining local peer of the owner,
 * which gives a last-resort host migration.
 *
 * `sweepDisconnectedPeer` calls it, so it runs automatically on disconnect.
 */
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
