/**
 * Disconnect sweep. It has two responsibilities when a peer drops:
 *
 *   1. **Recover the authority** of every entity whose `AuthoritativeFor`
 *      targets the leaving peer now. The sweep selects the remaining peer of
 *      the owner-user of that entity with the lowest id. It falls back to
 *      `world.localPeer` when it knows no remaining local peer of the owner.
 *
 *   2. **Remove every entity that the leaving user owns**, when that user holds
 *      no remaining live connection on any network of this world.
 *
 *      Ownership means the `OwnedBy(user)` relation. When the last peer of a
 *      user disconnects, the sweep removes every entity that the user owns, and
 *      no opt-in tag changes that. An entity that must outlive the session of a
 *      user must therefore not be owned by that user. Give it a different
 *      owner, such as a world-scope entity.
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
 * Disconnect cleanup. Authority recovery always runs, because every disconnect
 * can cost an authority. The sweep of user-owned entities runs only when this
 * connection was the last connection of that user on the world.
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
  // This was the last connection of the user, so remove every entity that the
  // user owns. Snapshot the set first, because removeEntity mutates the
  // AuthoritativeFor query.
  const owned = bitecs.query(world.engine.bitECS, [OwnedBy.$relation(userEntity)]) as Entity[]
  for (const e of [...owned]) {
    if (e === userEntity) continue
    removeEntity(world, e)
  }
}

/**
 * Walk every entity in the world whose authority targets `connection.peer`, and
 * reassign each one through `recoverAuthority`. The function does nothing when
 * the connection carries no peer entity, which happens when its HELLO never
 * arrived.
 */
const recoverAuthorityForLeavingPeer = (world: World, connection: Connection): void => {
  const leavingPeer = connection.peer
  if (!leavingPeer) return
  // Walk every entity in the engine that targets the leaving peer through
  // AuthoritativeFor. The walk reads the targets index of the relation directly.
  const owingEntities: Entity[] = []
  for (const candidate of bitecs.query(world.engine.bitECS, [AuthoritativeFor.$relation(leavingPeer)]) as Entity[]) {
    if (getAuthority(world, candidate) === leavingPeer) owingEntities.push(candidate)
  }
  for (const e of owingEntities) recoverAuthority(world, e, leavingPeer)
}
