/**
 * Network helpers — construction + lifecycle for the `Network` type defined
 * in `ecs/world.ts`.
 *
 * Many networks per world for spatial segmentation, voice / video channels,
 * etc. The world's event log is canonical: networks don't have their own
 * histories. A mutation is routed to one or more networks by the mutation
 * pipeline (today: broadcast to all). Connections in each network ship the
 * same events through their own underlying transports.
 *
 * `'default'` is auto-created on first call to `ensureDefaultNetwork`. Use
 * `addNetwork(world, { id })` to add more.
 */

import type { Network, World } from '../ecs/world'

// Re-export the Network type from its canonical home for ergonomic imports
// (e.g. lifecycle modules use `import type { Network } from '../network'`).
export type { Network } from '../ecs/world'

export const DEFAULT_NETWORK_ID = 'default'

export interface AddNetworkOptions {
  /** Stable id. Used as the key in `world.networks`. */
  id: string
}

/** Add a network to a world. Throws if a network with the same id already exists. */
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

/** Remove a network from a world, closing its connections. */
export const removeNetwork = (world: World, id: string): void => {
  const network = world.networks.get(id)
  if (!network) return
  network.close()
  world.networks.delete(id)
}

/** Get (or lazily create) the default network. Used by single-network flows. */
export const ensureDefaultNetwork = (world: World): Network => {
  const existing = world.networks.get(DEFAULT_NETWORK_ID)
  if (existing) return existing
  return addNetwork(world, { id: DEFAULT_NETWORK_ID })
}
