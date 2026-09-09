/**
 * Disconnect handling, derived from presence rather than invoked.
 *
 * A peer either has a live connection or it does not, and `ConnectedTo` records
 * which. The lifecycle writes that component when a handshake completes and
 * removes it when the endpoint closes. Everything that must happen on a
 * disconnect happens because the component went away.
 *
 * This replaces a `sweepDisconnectedPeer(world, connection)` that four separate
 * call sites had to remember: the graceful-leave message, the endpoint close,
 * `leaveWorld`, and the in-memory link. Missing one of them left a departed
 * peer holding authority forever, with nothing to signal the mistake. The
 * observer cannot be forgotten, because there is no call to omit.
 *
 * Two consequences follow from one peer disconnecting:
 *
 *   1. **Authority moves on.** Every entity whose `AuthoritativeFor` names the
 *      departed peer needs a new writer, or it freezes.
 *   2. **The user's entities go**, but only once their *last* peer disconnects.
 *      A user with a desktop and a phone stays present while either survives.
 *
 * Neither authors. Every peer observes the same disconnect and runs the same
 * deterministic cleanup, so broadcasting it would tell peers that never lost
 * the connection to discard state they can still see.
 */

import { hasComponent } from '../ecs/component'
import { onWorldCreate, type Entity, type World } from '../ecs/world'
import { observe, onRemove } from '../ecs/observer'
import { parentOfFor, removeEntity } from '../ecs/entity'
import * as bitecs from 'bitecs'
import { AuthoritativeFor, OwnedBy, getAuthority, recoverAuthority } from './authority'
import { ConnectedTo, PeerComponent } from './agents'

/**
 * Hand every entity the departed peer was writing to a peer that remains.
 *
 * `recoverAuthority` picks the successor deterministically, so each observing
 * peer reaches the same one without coordinating.
 */
const recoverAuthorityFrom = (world: World, peer: Entity): void => {
  const stranded: Entity[] = []
  for (const candidate of bitecs.query(world.engine.bitECS, [AuthoritativeFor.$relation(peer)]) as Entity[]) {
    if (getAuthority(world, candidate) === peer) stranded.push(candidate)
  }
  for (const entity of stranded) recoverAuthority(world, entity, peer)
}

/**
 * Remove everything owned by the user of `peer`, once no peer of that user
 * holds a connection.
 *
 * Ownership is session-bound by structure. An entity that must outlive the
 * session of a user has to be owned by something else, such as a world-scope
 * entity.
 */
const sweepOwnerIfLastPeer = (world: World, peer: Entity): void => {
  const user = parentOfFor(world.engine).get(peer)
  if (user === undefined) return
  // Another peer of the same user still connected? Then the user is present.
  for (const sibling of bitecs.query(world.engine.bitECS, [ConnectedTo.$ref, PeerComponent.$ref]) as Entity[]) {
    if (sibling === peer) continue
    if (parentOfFor(world.engine).get(sibling) === user) return
  }
  // Snapshot first: removeEntity mutates the relation index being walked.
  const owned = Array.from(bitecs.query(world.engine.bitECS, [OwnedBy.$relation(user)]) as Entity[])
  for (const entity of owned) {
    if (entity === user || entity === peer) continue
    removeEntity(world, entity)
  }
}

onWorldCreate((world) => {
  observe(world, onRemove(ConnectedTo), (peer: Entity) => {
    // bitECS fires this while tearing an entity down as well as on a plain
    // component removal. A peer entity that is itself going away has no
    // authority left to recover and no session to close.
    if (!hasComponent(world, peer, PeerComponent)) return
    recoverAuthorityFrom(world, peer)
    sweepOwnerIfLastPeer(world, peer)
  })
})
