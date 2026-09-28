/**
 * Network — the sync topology of a world.
 *
 * A `Network` holds a named set of connections. That grouping serves routing —
 * voice vs gameplay vs admin — and rebroadcast scoping. A Network holds no
 * governance state. Governance runs engine-internally: `validateEvent` walks
 * the constraint entities in the world. See `governance.ts`.
 *
 * The networks themselves live on `world.networks`. This module holds the
 * operations. The world holds the state, so `destroyWorld` clears its own field
 * rather than each layer keeping a side table of its own.
 */

import type { AuthoredEnvelope, AuthoredEvent, Entity, World } from '../ecs/world'
import type { Connection } from './transport'
import { validateEvent } from './governance'

// ── Network ──────────────────────────────────────────────────────────────────

export interface Network {
  readonly id: string
  /** Active peer connections on this network. */
  readonly connections: Set<Connection>
  /** Close every connection, and release the per-network state. */
  close(): void
}

// ── Dispatch ─────────────────────────────────────────────────────────────────
//
// The mutation pipeline and the lifecycle call these. A caller never reaches
// into the network directly.

/** Fan an authored envelope across every connection on the network. */
export const publishAuthored = (_world: World, network: Network, envelope: AuthoredEnvelope): void => {
  for (const conn of network.connections) conn.events.send(envelope)
}

/** Hand the dirty set to the binary channel of each connection. */
export const publishRuntime = (_world: World, network: Network, dirty: Map<string, Set<Entity>>): void => {
  for (const conn of network.connections) conn.channel?.publish(dirty)
}

/** Run governance for one inbound event. It walks the constraint entities in
 *  the world and returns false when any constraint rejects. */
export const validateAuthored = (world: World, event: AuthoredEvent): boolean => validateEvent(world, event).allowed

// ── Lookups ───────────────────────────────────────────────────────────────────

/** Iterate every network on this world. */
export const getNetworks = (world: World): Map<string, Network> => world.networks

/** Get a network by id, if one exists. */
export const getNetwork = (world: World, id: string): Network | undefined => world.networks.get(id)

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export const DEFAULT_NETWORK_ID = 'default'

export interface AddNetworkOptions {
  /** Stable id. It serves as the key in the network registry of the world. */
  id: string
}

/** Add a network to a world. The function throws when a network with the same
 *  id already exists. */
export const addNetwork = (world: World, options: AddNetworkOptions): Network => {
  if (world.networks.has(options.id)) {
    throw new Error(`addNetwork: world already has a network with id '${options.id}'`)
  }
  const network: Network = {
    id: options.id,
    connections: new Set(),
    close() {
      for (const conn of network.connections) conn.close()
      network.connections.clear()
    }
  }
  world.networks.set(options.id, network)
  return network
}

/** Remove a network from a world, and close its connections. */
export const removeNetwork = (world: World, id: string): void => {
  const network = world.networks.get(id)
  if (!network) return
  network.close()
  world.networks.delete(id)
}

/**
 * Get the default network, and create it lazily when it does not exist.
 */
export const ensureDefaultNetwork = (world: World): Network => {
  const existing = getNetwork(world, DEFAULT_NETWORK_ID)
  if (existing) return existing
  return addNetwork(world, { id: DEFAULT_NETWORK_ID })
}
