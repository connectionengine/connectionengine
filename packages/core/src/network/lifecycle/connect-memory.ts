/**
 * Link two worlds over a pair of in-memory `TransportEndpoint` objects, without
 * the formal `joinNetwork` handshake.
 *
 * Authored envelopes fan out through `installFanout`. When the caller supplies
 * `runtimeComponents`, the function attaches a `BinaryChannel` to each
 * Connection, so that the runtime SoA deltas flow over a per-peer binary
 * pipeline.
 *
 * Use this function for an envelope-level integration test. Use `joinNetwork`
 * for the production-shaped path, which includes late join and event-log
 * replay.
 *
 * The connection joins the `'default'` network of each side, which the engine
 * creates on demand.
 */

import type { AuthoredEvent, Entity, World } from '../../ecs/world'
import type { ComponentDefinition } from '../../ecs/component'
import { getComponent, setComponent } from '../../ecs/component'
import { applyAuthoredEnvelope } from '../mutation'
import { createEntity } from '../../ecs/entity'
import { getEntityByUID, getEntityPath, setUID } from '../../ecs/entity'
import { addRelation } from '../../ecs/relation'
import { AuthoritativeFor, OwnedBy } from '../authority'
import { PeerComponent, UserComponent } from '../agents'
import type { Connection } from '../network'
import { createMemoryTransport, type RuntimeTransportConfig, type TransportEndpoint } from '../transport'
import { ensureDefaultNetwork, type Network } from '../network'
import { createBinaryChannel, isBindControl, type BindControlMessage } from './binary-channel'
import { ensureChannel, installFanout, rebroadcastAuthored, setConnectionChannel } from './fanout'
import { sweepDisconnectedPeer } from './sweep'

export interface MemoryConnectionPair {
  a: Connection
  b: Connection
  close(): void
}

export interface ConnectInMemoryOptions {
  validate?: (world: World, event: AuthoredEvent) => boolean
  latencyMs?: number
  runtimeComponents?: readonly ComponentDefinition[]
  runtimeConfigs?: RuntimeTransportConfig[]
}

const isAuthoredEnvelope = (payload: unknown): payload is { fromPeer: string; events: AuthoredEvent[] } =>
  !!payload && typeof payload === 'object' && Array.isArray((payload as { events?: unknown }).events)

interface RemoteIdentity {
  did: string
  peerId: string
  userPath: string[]
  peerPath: string[]
}

const wireSide = (
  world: World,
  network: Network,
  remote: RemoteIdentity,
  endpoint: TransportEndpoint,
  options: ConnectInMemoryOptions
): Connection => {
  const connection: Connection = {
    peer: ensureRemotePeerEntity(world, remote),
    remoteDID: remote.did,
    events: endpoint.events,
    stream: endpoint.stream,
    onClose: (h) => endpoint.onClose(h),
    close: () => {
      network.connections.delete(connection)
      endpoint.close()
    }
  }
  if (options.runtimeComponents && options.runtimeComponents.length > 0) {
    setConnectionChannel(
      connection,
      createBinaryChannel(world, connection, {
        components: options.runtimeComponents,
        configs: options.runtimeConfigs
      })
    )
  }
  endpoint.events.onMessage((payload) => {
    if (isBindControl(payload)) {
      ensureChannel(world, connection)?.registerBindings((payload as BindControlMessage).bindings)
      return
    }
    if (isAuthoredEnvelope(payload)) {
      applyAuthoredEnvelope(world, payload, network)
      rebroadcastAuthored(world, connection, payload)
      return
    }
  })
  endpoint.stream.onMessage((buffer) => {
    ensureChannel(world, connection)?.applyBuffer(buffer)
  })
  endpoint.onClose(() => {
    sweepDisconnectedPeer(world, connection)
    network.connections.delete(connection)
  })
  network.connections.add(connection)
  return connection
}

export const connectInMemory = (
  worldA: World,
  worldB: World,
  options: ConnectInMemoryOptions = {}
): MemoryConnectionPair => {
  const networkA = ensureDefaultNetwork(worldA)
  const networkB = ensureDefaultNetwork(worldB)
  if (options.validate) {
    const v = options.validate
    if (!networkA.validateAuthored) networkA.validateAuthored = (e) => v(worldA, e)
    if (!networkB.validateAuthored) networkB.validateAuthored = (e) => v(worldB, e)
  }
  installFanout(worldA, networkA)
  installFanout(worldB, networkB)
  const transport = createMemoryTransport({ latencyMs: options.latencyMs })
  const a = wireSide(worldA, networkA, identityOf(worldB), transport.a, options)
  const b = wireSide(worldB, networkB, identityOf(worldA), transport.b, options)
  return {
    a,
    b,
    close: () => {
      a.close()
      b.close()
      transport.close()
    }
  }
}

const identityOf = (world: World): RemoteIdentity => {
  const peerId =
    world.localPeer !== undefined
      ? ((getComponent(world, world.localPeer, PeerComponent) as { peerId?: string } | undefined)?.peerId ??
        world.localAgent.did)
      : world.localAgent.did
  return {
    did: world.localAgent.did,
    peerId,
    userPath: world.localUser !== undefined ? getEntityPath(world, world.localUser) : [],
    peerPath: world.localPeer !== undefined ? getEntityPath(world, world.localPeer) : []
  }
}

const ensureRemotePeerEntity = (world: World, remote: RemoteIdentity): Entity => {
  const userPath = remote.userPath.length > 0 ? remote.userPath : [`user:${remote.did}`]
  const peerPath = remote.peerPath.length > 0 ? remote.peerPath : [...userPath, `peer:${remote.peerId}`]
  const user = ensureAgentPath(world, userPath, (cursor) => {
    setComponent(world, cursor, UserComponent, { did: remote.did, displayName: '' }, { origin: 'network' })
    addRelation(world, cursor, OwnedBy, cursor, { origin: 'network' })
  })
  return ensureAgentPath(world, peerPath, (cursor) => {
    setComponent(world, cursor, PeerComponent, { peerId: remote.peerId, latency: 0 }, { origin: 'network' })
    addRelation(world, cursor, OwnedBy, user, { origin: 'network' })
    addRelation(world, cursor, AuthoritativeFor, cursor, { origin: 'network' })
  })
}

/**
 * Walk a UID path, and create every missing node silently. The function runs
 * `decorate` on the leaf when, and only when, it created that leaf. A leaf that
 * already existed already carries its components, from replay or from local
 * setup.
 */
const ensureAgentPath = (world: World, path: string[], decorate: (entity: Entity) => void): Entity => {
  let parent: Entity = world.worldRoot
  let cursor: Entity = world.worldRoot
  let freshLeaf = false
  for (let i = 0; i < path.length; i++) {
    const uid = path[i]
    const existing = getEntityByUID(world, parent, uid)
    if (existing !== undefined) {
      cursor = existing
      freshLeaf = false
    } else {
      cursor = createEntity(world)
      if (parent === world.worldRoot) setUID(world, cursor, uid, { origin: 'network' })
      else setUID(world, cursor, uid, { parent, origin: 'network' })
      freshLeaf = i === path.length - 1
    }
    parent = cursor
  }
  if (freshLeaf) decorate(cursor)
  return cursor
}
