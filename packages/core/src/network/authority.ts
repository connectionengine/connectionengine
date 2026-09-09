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
 * Taking authority is always a **request**. `requestAuthority` asks, and
 * `transferAuthority` asks on behalf of another peer. Neither assigns: every
 * peer judges the resulting event for itself, so a request the network would
 * refuse is refused locally too, and the world never diverges.
 *
 * The same standing rule applies on both sides:
 *   - **Requester**: the local peer must already hold the authority, or belong
 *     to the same user as the owner. `requestAuthority` returns the refusal
 *     rather than throwing, because being refused is an ordinary outcome.
 *   - **Receiver**: `applyAuthoredEnvelope`, in `network/mutation.ts`, runs the
 *     equivalent check on every incoming `AuthoritativeFor` mutation. The author
 *     DID must match the owner-user, or the user of the current authority. A
 *     failed event is rejected and never applied.
 */

import { defineRelation, getRelationTargets, addRelation } from '../ecs/relation'
import { hasComponent } from '../ecs/component'
import { parentOfFor, resolveEntityPath } from '../ecs/entity'
import { getUserDID, PeerComponent } from './agents'
import type { Entity, Origin, World, AuthoredEvent } from '../ecs/world'

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

/**
 * Would a transfer of `entity` to a new peer be granted?
 *
 * The same question `requestAuthority` answers, without acting on it. Use it to
 * grey out a control, or to skip an attempt you know will be refused.
 *
 * Standing means one of two things: the local peer already holds the authority,
 * or it belongs to the same user as the owner. Any peer of the owner may move
 * authority between that user's devices, and the current holder may pass it on,
 * which is what host migration needs.
 */
export const canRequestAuthority = (world: World, entity: Entity): boolean => {
  const localPeer = world.localPeer
  if (localPeer === undefined) return false
  if (getAuthority(world, entity) === localPeer) return true
  const owner = getOwner(world, entity)
  if (owner === undefined) return false
  return parentOfFor(world.engine).get(localPeer) === owner
}

export const getAuthority = (world: World, entity: Entity): Entity | undefined =>
  getRelationTargets(world, entity, AuthoritativeFor)[0]

export interface AuthorityRequestResult {
  granted: boolean
  /** Why the request failed. Absent on a grant. */
  reason?: string
}

/**
 * Ask to become the authority for `entity`.
 *
 * Taking authority is always a request, never an assignment. Every peer decides
 * for itself whether to honour the resulting event, and a peer without standing
 * gets refused everywhere. This returns the same verdict locally that the other
 * peers will reach, so a refusal costs nothing and never diverges the world.
 *
 * A granted request emits exactly **one** authored event, the `set`.
 * `AuthoritativeFor` is exclusive, so bitECS drops the previous holder when the
 * new one lands, on the requester and on every peer alike.
 *
 * Emitting an explicit `remove` first would break host migration. A receiver
 * judges each event against current state, so it would accept the remove from
 * the outgoing holder, leaving the entity with no authority, and then refuse
 * the follow-up `set` because its author no longer matches the current
 * authority. The peers would disagree permanently.
 */
export const requestAuthority = (world: World, entity: Entity, peer: Entity): AuthorityRequestResult => {
  if (getAuthority(world, entity) === peer) return { granted: true }
  if (world.localPeer === undefined) {
    return { granted: false, reason: 'world has no local peer' }
  }
  if (getOwner(world, entity) === undefined) {
    return { granted: false, reason: 'entity has no owner — invariant violation' }
  }
  if (!canRequestAuthority(world, entity)) {
    return {
      granted: false,
      reason: `local peer is neither the current authority nor a peer of the owner-user`
    }
  }
  grantAuthority(world, entity, peer)
  return { granted: true }
}

/** Ask to hand the authority for `entity` to `newPeer`. An alias for
 *  `requestAuthority`, for the case where the local peer is passing it on
 *  rather than taking it. */
export const transferAuthority = (world: World, entity: Entity, newPeer: Entity): AuthorityRequestResult =>
  requestAuthority(world, entity, newPeer)

/**
 * Write the authority relation with no standing check.
 *
 * Only the bootstrap paths use it, where no authority exists yet to ask: the
 * self-authority of `createPeer`, the remote-peer materialisation on the
 * receive path, and `recoverAuthority` after a disconnect. Application code
 * calls `requestAuthority` instead.
 */
export const grantAuthority = (world: World, entity: Entity, peer: Entity, options: { origin?: Origin } = {}): void => {
  if (getRelationTargets(world, entity, AuthoritativeFor)[0] === peer) return
  addRelation(world, entity, AuthoritativeFor, peer, { origin: options.origin ?? 'local' })
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
 *
 * The reassignment does not author. Every peer that sees the disconnect runs
 * this same deterministic choice and reaches the same successor, so an event
 * would be redundant. It would also usually be refused: the peer doing the
 * recovery is rarely the owner-user or the outgoing authority, which is exactly
 * what the receive-side standing check rejects.
 */
export const recoverAuthority = (world: World, entity: Entity, disconnectedPeer: Entity): void => {
  const current = getAuthority(world, entity)
  if (current !== disconnectedPeer) return
  const owner = getOwner(world, entity)
  if (owner === undefined) return
  let lowest: Entity | undefined
  for (const [child, parent] of parentOfFor(world.engine)) {
    if (parent !== owner) continue
    if (child === disconnectedPeer) continue
    // Every child of the owner-user shares this index, including ordinary
    // entities spawned with `{ parent: user }`. Only a Peer can hold authority.
    if (!hasComponent(world, child, PeerComponent)) continue
    if (lowest === undefined || child < lowest) lowest = child
  }
  const successor = lowest ?? world.localPeer
  if (successor === undefined || successor === disconnectedPeer) return
  grantAuthority(world, entity, successor, { origin: 'network' })
}
