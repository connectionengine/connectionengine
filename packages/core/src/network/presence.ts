/**
 * What a lost connection undoes.
 *
 * The forward effect runs in `attachConnection`: a completed handshake writes
 * `ConnectedTo`, adds the connection to its network, and grants the remote peer
 * authority over its own entities. `disconnectPeer` reverses exactly that, and
 * `attachConnection` registers it on `connection.onClose` at the moment it does
 * the forward half. Setup and teardown therefore land together, and no call
 * site can perform one without the other.
 *
 * This replaces an observer on `onRemove(ConnectedTo)`. The observer registered
 * per world but fired per engine, so every world sharing an engine ran the
 * cleanup for every other world's disconnect, and it never detached. Pairing
 * the teardown with the setup fixes both, and keeps the answer to "what happens
 * when a peer drops?" in one function.
 *
 * `ConnectedTo` stays as state — `connectedPeers` and the last-peer-standing
 * query read it. It simply stops serving as an event source.
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
 * the connection to discard state they can still see. `flushAuthored` enforces
 * that structurally: the swept entities belong to the departing user, never to
 * the local one, so the ownership gate drops every queued destroy.
 */

import { hasComponent, removeComponent } from '../ecs/component'
import type { Entity, World } from '../ecs/world'
import { BelongsTo, removeEntity } from '../ecs/entity'
import * as bitecs from 'bitecs'
import { AuthoritativeFor, OwnedBy, recoverAuthority } from './authority'
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
    if (AuthoritativeFor.get(world, candidate) === peer) stranded.push(candidate)
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
  const user = BelongsTo.indexFor(world.engine).get(peer)
  if (user === undefined) return
  // Another peer of the same user still connected? Then the user is present.
  for (const sibling of bitecs.query(world.engine.bitECS, [ConnectedTo.$ref, PeerComponent.$ref]) as Entity[]) {
    if (sibling === peer) continue
    if (BelongsTo.indexFor(world.engine).get(sibling) === user) return
  }
  // Snapshot first: removeEntity mutates the relation index being walked.
  const owned = Array.from(bitecs.query(world.engine.bitECS, [OwnedBy.$relation(user)]) as Entity[])
  for (const entity of owned) {
    if (entity === user || entity === peer) continue
    removeEntity(world, entity)
  }
}

/**
 * Undo what a connection established. `attachConnection` registers this on
 * `connection.onClose`, so it runs however the connection ends: a graceful
 * `leave`, a dropped transport, `leaveWorld`, or a closed in-memory link.
 *
 * The function tolerates a second call. Dropping `ConnectedTo` first means a
 * repeat finds nothing connected and stops, which matters because a transport
 * may report a close more than once.
 */
export const disconnectPeer = (world: World, peer: Entity): void => {
  // A peer entity already torn down has no authority to recover and no session
  // to close.
  if (!hasComponent(world, peer, PeerComponent)) return
  if (!hasComponent(world, peer, ConnectedTo)) return
  removeComponent(world, peer, ConnectedTo)
  recoverAuthorityFrom(world, peer)
  sweepOwnerIfLastPeer(world, peer)
}
