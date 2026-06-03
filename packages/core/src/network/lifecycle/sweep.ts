/**
 * Disconnect sweep — remove a leaving user's TransientOnDisconnect entities
 * when their last live peer connection drops.
 */

import type { Connection, Entity, World } from '../../ecs/world'
import { componentEntities, getComponent } from '../../ecs/component'
import { removeEntity } from '../../ecs/entity'
import { getOwner } from '../authority'
import { TransientOnDisconnect, UserComponent } from '../peer'

const findUserByDID = (world: World, did: string): Entity | undefined => {
  for (const e of componentEntities(world, UserComponent)) {
    const u = getComponent(world, e, UserComponent) as { did?: string } | undefined
    if (u?.did === did) return e
  }
  return undefined
}

/**
 * If `connection` was the last live connection for its user, sweep every
 * TransientOnDisconnect entity owned by that user. No-op if other live peers
 * still represent the same user.
 */
export const sweepDisconnectedPeer = (world: World, connection: Connection): void => {
  const did = connection.remoteDID
  if (!did || did.startsWith('did:unknown')) return
  const userEntity = findUserByDID(world, did)
  if (userEntity === undefined) return
  for (const other of world.network.connections) {
    if (other === connection) continue
    if (other.remoteDID && findUserByDID(world, other.remoteDID) === userEntity) return
  }
  for (const candidate of componentEntities(world, TransientOnDisconnect)) {
    if (getOwner(world, candidate) !== userEntity) continue
    removeEntity(world, candidate)
  }
}
