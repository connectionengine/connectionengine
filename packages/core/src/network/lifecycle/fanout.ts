/**
 * Outbound fanout — wire `world.network.publish{Authored,Runtime}` to fan
 * across every live connection.
 *
 * Authored envelopes are passed through as-is (in-process JS objects);
 * runtime mutations delegate to each connection's BinaryChannel for binary
 * encoding + per-peer shadow tracking.
 */

import type { AuthoredEnvelope, Connection, Entity, World } from '../../ecs/world'
import { allComponents } from '../../ecs/component'
import { hasEventBeenSeen } from '../../engine/mutation'
import { createBinaryChannel, type BinaryChannel } from './binary-channel'

const channels = new WeakMap<Connection, BinaryChannel>()

export const setConnectionChannel = (connection: Connection, channel: BinaryChannel): void => {
  channels.set(connection, channel)
}

export const getConnectionChannel = (connection: Connection): BinaryChannel | undefined => channels.get(connection)

/**
 * Get-or-create the binary channel for a connection. Lazy auto-build draws
 * from every globally-defined runtime ComponentDefinition (sorted by id for
 * deterministic peer-agnostic order) — the global registry guarantees both
 * sides arrive at the same list as long as both packages have imported the
 * same component modules.
 */
export const ensureChannel = (world: World, connection: Connection): BinaryChannel | undefined => {
  let channel = channels.get(connection)
  if (channel) return channel
  const components = allComponents()
    .filter((c) => c.mutationCategory === 'runtime')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (components.length === 0) return undefined
  channel = createBinaryChannel(world, connection, { components })
  channels.set(connection, channel)
  return channel
}

const installed = new WeakSet<World>()

/**
 * Install the world-level publish hooks. Idempotent per-world: first call wires;
 * subsequent calls noop. The hooks themselves iterate `world.network.connections`
 * each tick so connections added later participate automatically.
 */
export const installFanout = (world: World): void => {
  if (installed.has(world)) return
  installed.add(world)
  world.network.publishAuthored = (envelope: AuthoredEnvelope) => {
    for (const conn of world.network.connections) conn.send(envelope)
  }
  world.network.publishRuntime = (dirty: Map<string, Set<Entity>>) => {
    for (const conn of world.network.connections) {
      const channel = ensureChannel(world, conn)
      if (!channel) continue
      channel.publish(dirty)
    }
  }
}

/**
 * Receive-side gate: an authored envelope just arrived from `connection`.
 * Re-broadcast its events to every OTHER connection that hasn't already seen
 * them — implements simple flood-fill propagation across the mesh. The
 * incoming events themselves are then applied via `applyAuthoredEnvelope`
 * by the caller.
 */
export const rebroadcastAuthored = (world: World, source: Connection, envelope: AuthoredEnvelope): void => {
  const fresh = envelope.events.filter((e) => !hasEventBeenSeen(world, e))
  if (fresh.length === 0) return
  const out: AuthoredEnvelope = { fromPeer: envelope.fromPeer, events: fresh }
  for (const conn of world.network.connections) {
    if (conn === source) continue
    conn.send(out)
  }
}
