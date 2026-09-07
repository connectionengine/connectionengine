/**
 * Outbound fanout. It attaches the `publishAuthored` and `publishRuntime` hooks
 * of each Network, so that each hook fans across the connection set of its own
 * network.
 *
 * `routeNetworks(world, entity)` in `mutation.ts` routes each mutation to its
 * networks, and today it broadcasts to all of them. The hook of a network
 * receives only the events and dirty entries that routing sent to it. This
 * module fans out within the connections of one network, and does nothing more.
 */

import type { AuthoredEnvelope, Entity, World } from '../../ecs/world'
import { allComponents, hasSyncedSoA } from '../../ecs/component'
import { hasEventBeenSeen } from '../mutation'
import type { Connection, Network } from '../network'
import { getNetworks } from '../network'
import { createBinaryChannel, type BinaryChannel } from './binary-channel'

const channels = new WeakMap<Connection, BinaryChannel>()

export const setConnectionChannel = (connection: Connection, channel: BinaryChannel): void => {
  channels.set(connection, channel)
}

export const getConnectionChannel = (connection: Connection): BinaryChannel | undefined => channels.get(connection)

/**
 * Get the binary channel of a connection, or create it. The lazy build draws
 * from every continuous-channel ComponentDefinition on the engine of the world,
 * sorted by id for a deterministic, peer-agnostic order. The engine registry
 * then guarantees that both sides reach the same list, for as long as both
 * packages have imported the same component modules.
 */
export const ensureChannel = (world: World, connection: Connection): BinaryChannel | undefined => {
  let channel = channels.get(connection)
  if (channel) return channel
  const components = allComponents()
    .filter(hasSyncedSoA)
    .sort((a, b) => (a.$id < b.$id ? -1 : a.$id > b.$id ? 1 : 0))
  if (components.length === 0) return undefined
  channel = createBinaryChannel(world, connection, { components })
  channels.set(connection, channel)
  return channel
}

/**
 * Install the fanout on a network. The function is idempotent. It attaches
 * `publishAuthored` and `publishRuntime`, so that each hook fans across the
 * connections of this network. The runtime binary path uses the `BinaryChannel`
 * of each connection.
 */
export const installFanout = (world: World, network: Network): void => {
  if (network.publishAuthored && network.publishRuntime) return
  if (!network.publishAuthored) {
    network.publishAuthored = (envelope: AuthoredEnvelope) => {
      for (const conn of network.connections) conn.events.send(envelope)
    }
  }
  if (!network.publishRuntime) {
    network.publishRuntime = (dirty: Map<string, Set<Entity>>) => {
      for (const conn of network.connections) {
        const channel = ensureChannel(world, conn)
        if (!channel) continue
        channel.publish(dirty)
      }
    }
  }
}

/**
 * Receive-side gate. An authored envelope has just arrived from `connection` on
 * `network`. The function broadcasts its events again, to every OTHER
 * connection on every network of this world that has not seen them. That gives
 * a mesh flood. The caller then applies the incoming events themselves, through
 * `applyAuthoredEnvelope`.
 */
export const rebroadcastAuthored = (world: World, source: Connection, envelope: AuthoredEnvelope): void => {
  const fresh = envelope.events.filter((e) => !hasEventBeenSeen(world, e))
  if (fresh.length === 0) return
  const out: AuthoredEnvelope = { fromPeer: envelope.fromPeer, events: fresh }
  for (const network of getNetworks(world).values()) {
    for (const conn of network.connections) {
      if (conn === source) continue
      conn.events.send(out)
    }
  }
}
