/**
 * Outbound fanout — wire each Network's `publishAuthored` / `publishRuntime`
 * to fan across its own connection set.
 *
 * Mutations are routed to networks by `routeNetworks(world, entity)` in
 * `mutation.ts` (today: broadcast-to-all). Each network's hook receives only
 * the events / dirty entries routed to it; this module just fans within a
 * network's connections.
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
 * Get-or-create the binary channel for a connection. Lazy auto-build draws
 * from every continuous-channel ComponentDefinition on the world's engine
 * (sorted by id for deterministic peer-agnostic order) — the engine registry
 * guarantees both sides arrive at the same list as long as both packages have
 * imported the same component modules.
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
 * Install fanout on a network. Idempotent. `publishAuthored` and
 * `publishRuntime` are wired to fan across this network's connections; the
 * binary path for runtime uses each connection's `BinaryChannel`.
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
 * Receive-side gate: an authored envelope just arrived from `connection` on
 * `network`. Re-broadcast its events to every OTHER connection across every
 * network on the world that hasn't already seen them — mesh flood. The
 * incoming events themselves are then applied via `applyAuthoredEnvelope`
 * by the caller.
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
