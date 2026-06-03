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
 * If `connection` was the last live connection across every network on this
 * world for its user, sweep every TransientOnDisconnect entity owned by that
 * user. Walks all of `world.networks` because the same user may be reachable
 * via voice on one network and gameplay on another.
 */
export const sweepDisconnectedPeer = (world: World, connection: Connection): void => {
  const did = connection.remoteDID
  if (!did || did.startsWith('did:unknown')) return
  const userEntity = findUserByDID(world, did)
  if (userEntity === undefined) return
  for (const network of world.networks.values()) {
    for (const other of network.connections) {
      if (other === connection) continue
      if (other.remoteDID && findUserByDID(world, other.remoteDID) === userEntity) return
    }
  }
  for (const candidate of componentEntities(world, TransientOnDisconnect)) {
    if (getOwner(world, candidate) !== userEntity) continue
    removeEntity(world, candidate)
  }
}
