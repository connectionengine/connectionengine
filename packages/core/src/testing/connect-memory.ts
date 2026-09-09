/**
 * Test and development utility: link two worlds in one process, skipping the
 * `joinNetwork` handshake.
 *
 * It lives in `testing/` because that is what it is. Production code opens a
 * session with `joinNetwork`, which handshakes, replays the event log, and
 * bootstraps a snapshot. This shortcut does none of that — it wires two worlds
 * together directly so a test can assert on envelope-level behaviour without
 * driving a protocol.
 *
 * It ships rather than living under `tests/` because `@connectionengine/local`
 * builds `connectLocalInMemory` on top of it.
 *
 * Authored envelopes leave through the outbound path each network was built
 * with, which defaults to fanning across its connections. Each Connection also
 * gets a `BinaryChannel`, so that the runtime SoA deltas flow over a per-peer
 * binary pipeline. Pass `runtimeComponents` to fix the wire order explicitly;
 * otherwise both sides derive it from the registered continuous components.
 *
 * Use this function for an envelope-level integration test. Use `joinNetwork`
 * for the production-shaped path, which includes late join and event-log
 * replay.
 *
 * The connection joins the `'default'` network of each side, which the engine
 * creates on demand. Network behaviours in the options — the gate, the outbound
 * paths — apply only to a side whose network this call creates, because a
 * network fixes its behaviour at construction.
 */

import type { AuthoredEvent, Entity, World } from '../ecs/world'
import type { ComponentDefinition } from '../ecs/component'
import { getComponent, setComponent } from '../ecs/component'
import { applyAuthoredEnvelope } from '../network/mutation'
import { createEntity } from '../ecs/entity'
import { getEntityByUID, getEntityPath, setUID } from '../ecs/entity'
import { addRelation } from '../ecs/relation'
import { AuthoritativeFor, OwnedBy } from '../network/authority'
import { ConnectedTo, PeerComponent, UserComponent } from '../network/agents'
import type { Connection } from '../network/network'
import { createMemoryTransport, type RuntimeTransportConfig, type TransportEndpoint } from '../network/transport'
import { ensureDefaultNetwork, type AddNetworkOptions, type Network } from '../network/network'
import { isBindControl, type BindControlMessage } from '../network/lifecycle/binary-channel'
import { attachRuntimeChannel, disconnected, rebroadcastAuthored } from '../network/lifecycle/session'

export interface MemoryConnectionPair {
  a: Connection
  b: Connection
  close(): void
}

/**
 * The network behaviours travel under their own names, the same ones
 * `addNetwork` takes. They apply only when this call is the one that creates
 * the default network of a side — behaviour is fixed at construction.
 */
export interface ConnectInMemoryOptions extends Omit<AddNetworkOptions, 'id'> {
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
  const peerEntity = ensureRemotePeerEntity(world, remote)
  setComponent(world, peerEntity, ConnectedTo, { networkId: network.id })
  const connection: Connection = {
    peer: peerEntity,
    remoteDID: remote.did,
    events: endpoint.events,
    stream: endpoint.stream,
    onClose: (h) => endpoint.onClose(h),
    close: () => {
      network.connections.delete(connection)
      endpoint.close()
    }
  }
  attachRuntimeChannel(world, connection, {
    components: options.runtimeComponents,
    configs: options.runtimeConfigs
  })
  endpoint.events.onMessage((payload) => {
    if (isBindControl(payload)) {
      connection.channel?.registerBindings((payload as BindControlMessage).bindings)
      return
    }
    if (isAuthoredEnvelope(payload)) {
      // Apply first, then relay what the apply accepted. See `rebroadcastAuthored`.
      const accepted = applyAuthoredEnvelope(world, payload, network)
      rebroadcastAuthored(network, connection, payload.fromPeer, accepted)
      return
    }
  })
  endpoint.stream.onMessage((buffer) => {
    connection.channel?.applyBuffer(buffer)
  })
  endpoint.onClose(() => {
    disconnected(world, connection)
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
  const networkA = ensureDefaultNetwork(worldA, options)
  const networkB = ensureDefaultNetwork(worldB, options)
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
