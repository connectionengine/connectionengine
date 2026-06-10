/**
 * Disconnect sweep — two responsibilities when a peer drops:
 *
 *   1. **Recover authority** for every entity whose `AuthoritativeFor`
 *      currently targets the leaving peer. Picks the lowest-id remaining peer
 *      of the entity's owner-user; falls back to `world.localPeer` if no peer
 *      of the owner remains locally known.
 *
 *   2. **Sweep every entity owned by the leaving user** when that user has no
 *      remaining live connection across any network on this world.
 *
 *      Ownership = the `OwnedBy(user)` relation. When the user's last peer
 *      disconnects, every entity owned by them is removed — no opt-in tag.
 *      Entities meant to outlive a user's session must not be owned by that
 *      user (give them a different owner, e.g. a world-scope entity).
 */

import * as bitecs from 'bitecs'
import type { Entity, World } from '../../ecs/world'
import { getComponent } from '../../ecs/component'
import { removeEntity } from '../../ecs/entity'
import { query } from '../../ecs/query'
import { AuthoritativeFor, OwnedBy, getAuthority, recoverAuthority } from '../authority'
import { UserComponent } from '../agents'
import type { Connection } from '../network'
import { getNetworks } from '../network'

const findUserByDID = (world: World, did: string): Entity | undefined => {
  for (const e of query(world, [UserComponent])) {
    const u = getComponent(world, e, UserComponent) as { did?: string } | undefined
    if (u?.did === did) return e
  }
  return undefined
}

/**
 * Disconnect cleanup. Always runs authority recovery (every disconnect is a
 * potential authority loss); user-owned sweep runs only when this was the
 * user's last connection on the world.
 */
export const sweepDisconnectedPeer = (world: World, connection: Connection): void => {
  recoverAuthorityForLeavingPeer(world, connection)

  const did = connection.remoteDID
  if (!did || did.startsWith('did:unknown')) return
  const userEntity = findUserByDID(world, did)
  if (userEntity === undefined) return
  for (const network of getNetworks(world).values()) {
    for (const other of network.connections) {
      if (other === connection) continue
      if (other.remoteDID && findUserByDID(world, other.remoteDID) === userEntity) return
    }
  }
  // Last connection for this user — remove every entity they own. Snapshot
  // first because removeEntity mutates the AuthoritativeFor query.
  const owned = bitecs.query(world.engine.bitECS, [OwnedBy.$relation(userEntity)]) as Entity[]
  for (const e of [...owned]) {
    if (e === userEntity) continue
    removeEntity(world, e)
  }
}

/**
 * Walk every entity in the world whose authority targets `connection.peer`
 * and reassign via `recoverAuthority`. Skipped when the connection has no
 * associated peer entity (HELLO never landed).
 */
const recoverAuthorityForLeavingPeer = (world: World, connection: Connection): void => {
  const leavingPeer = connection.peer
  if (!leavingPeer) return
  // Walk every entity in the engine that targets the leaving peer via
  // AuthoritativeFor. We use the relation's targets index directly.
  const owingEntities: Entity[] = []
  for (const candidate of bitecs.query(world.engine.bitECS, [AuthoritativeFor.$relation(leavingPeer)]) as Entity[]) {
    if (getAuthority(world, candidate) === leavingPeer) owingEntities.push(candidate)
  }
  for (const e of owingEntities) recoverAuthority(world, e, leavingPeer)
}
