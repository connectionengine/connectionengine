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
 * It sits in `src/` rather than under `tests/`, because `@connectionengine/local`
 * builds `connectLocalInMemory` on top of it.
 *
 * Authored envelopes leave through the outbound path each network was built
 * with, which defaults to fanning across its connections. Each Connection also
 * gets a `BinaryChannel`, so that the runtime SoA deltas flow over a per-peer
 * binary pipeline. Pass `runtimeComponents` to fix the wire order explicitly.
 * Without it, both sides derive the order from the registered continuous
 * components.
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

import type { World } from '../ecs/world'
import type { ComponentDefinition } from '../ecs/component'
import { getComponent, setComponent } from '../ecs/component'
import { ensureEntityPath, getEntityPath } from '../ecs/entity'
import { addRelation } from '../ecs/relation'
import { applyAuthoredEnvelope, isAuthoredEnvelope } from '../network/mutation'
import { ConnectedTo, PeerComponent, UserComponent } from '../network/agents'
import { AuthoritativeFor, OwnedBy } from '../network/authority'
import {
  createMemoryTransport,
  type Connection,
  type RuntimeTransportConfig,
  type TransportEndpoint
} from '../network/transport'
import { ensureDefaultNetwork, type AddNetworkOptions, type Network } from '../network/network'
import {
  attachConnection,
  attachRuntimeChannel,
  isBindControl,
  rebroadcastAuthored,
  type BindControlMessage
} from '../network/lifecycle'

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

const wireSide = (
  world: World,
  network: Network,
  remoteWorld: World,
  endpoint: TransportEndpoint,
  options: ConnectInMemoryOptions
): Connection => {
  // Extract the remote world's identity.
  const remoteDid = remoteWorld.localAgent.did
  let remotePeerId = remoteDid
  if (remoteWorld.localPeer !== undefined) {
    const val = getComponent(remoteWorld, remoteWorld.localPeer, PeerComponent) as { peerId?: string } | undefined
    if (val?.peerId) remotePeerId = val.peerId
  }
  const remoteUserPath = remoteWorld.localUser !== undefined ? getEntityPath(remoteWorld, remoteWorld.localUser) : []
  const remotePeerPath = remoteWorld.localPeer !== undefined ? getEntityPath(remoteWorld, remoteWorld.localPeer) : []

  // Materialise the remote peer in the local world.
  const userPath = remoteUserPath.length > 0 ? remoteUserPath : [`user:${remoteDid}`]
  const peerPath = remotePeerPath.length > 0 ? remotePeerPath : [...userPath, `peer:${remotePeerId}`]
  const remoteUser = ensureEntityPath(world, userPath, (entity) => {
    setComponent(world, entity, UserComponent, { did: remoteDid, displayName: '' }, { origin: 'network' })
    OwnedBy.set(world, entity, entity, { origin: 'network' })
  })
  const peerEntity = ensureEntityPath(world, peerPath, (entity) => {
    setComponent(world, entity, PeerComponent, { peerId: remotePeerId, latency: 0 }, { origin: 'network' })
    OwnedBy.set(world, entity, remoteUser, { origin: 'network' })
    addRelation(world, entity, AuthoritativeFor, entity, { origin: 'network' })
  })

  setComponent(world, peerEntity, ConnectedTo, { networkId: network.id })
  const connection: Connection = {
    peer: peerEntity,
    remoteDID: remoteDid,
    events: endpoint.events,
    stream: endpoint.stream,
    onClose: (h) => endpoint.onClose(h),
    close: () => endpoint.close()
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
  attachConnection(world, network, connection)
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
  const a = wireSide(worldA, networkA, worldB, transport.a, options)
  const b = wireSide(worldB, networkB, worldA, transport.b, options)
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
