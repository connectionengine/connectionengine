/**
 * Network — the sync topology, and the per-world registry that holds it.
 *
 * A `Network` holds a connection set, the outbound publish hooks, and an
 * inbound governance gate. A world can hold many networks, for spatial
 * segmentation, for voice and video channels, and for similar purposes. The
 * event log of the world is canonical, and a network holds no history of its
 * own. The mutation pipeline routes each mutation to one or more networks, and
 * today it broadcasts to all of them. The connections of each network carry the
 * same events through their own underlying transports.
 *
 * The networks live in a per-world registry, keyed by `WeakMap<World, …>`,
 * rather than in a field on `World` itself. Networking is a network-layer
 * concern, and `ecs/world.ts` must not name it.
 */

import type { AuthoredEnvelope, AuthoredEvent, Entity, World } from '../ecs/world'
import { onWorldDestroy } from '../ecs/world'
import type { TransportChannel } from './transport'

// ── Connection ────────────────────────────────────────────────────────────────

/**
 * A live transport link to a peer, scoped to ONE Network. It holds the pair of
 * channels that the underlying `TransportEndpoint` exposes, plus the
 * session-level metadata: the remoteDID, and the local peer entity once the
 * session knows it.
 *
 *   - `connection.events.send(envelope|controlMessage)` — reliable, ordered.
 *   - `connection.stream.send(arrayBuffer)`             — binary runtime packets.
 *
 * Two peers can hold several Connections between them, one for each Network
 * that the pair share. Whether several Networks share one underlying transport
 * is a transport-layer concern, and the engine does not track it.
 */
export interface Connection {
  peer: Entity
  /** Remote agent DID. It holds `'did:unknown:pending'` until the hello arrives. */
  remoteDID: string
  readonly events: TransportChannel
  readonly stream: TransportChannel<ArrayBuffer>
  onClose(handler: () => void): () => void
  close(): void
}

// ── Network ──────────────────────────────────────────────────────────────────-

export interface Network {
  readonly id: string
  /** Active peer connections on this network. */
  readonly connections: Set<Connection>
  /** Outbound publish hook for authored envelopes on this network. */
  publishAuthored?: (envelope: AuthoredEnvelope) => void
  /** Outbound publish hook for runtime mutations on this network. */
  publishRuntime?: (dirty: Map<string, Set<Entity>>) => void
  /** Inbound governance gate. A return of false drops the event. */
  validateAuthored?: (event: AuthoredEvent) => boolean
  /**
   * Diagnostic for a dropped inbound event. `applyAuthoredEnvelope` calls it
   * with the reason whenever a gate refuses an event.
   *
   * Without it a rejection is invisible: the event does not apply, nothing
   * throws, and the two peers quietly hold different state. A duplicate does
   * not report here, because a mesh delivers the same event by several paths
   * and dropping the repeats is ordinary.
   */
  onReject?: (event: AuthoredEvent, reason: string) => void
  /** Close every connection, and release the per-network state. */
  close(): void
}

// ── Per-world registry ────────────────────────────────────────────────────────

const networksByWorld = new WeakMap<World, Map<string, Network>>()

const registryFor = (world: World): Map<string, Network> => {
  let m = networksByWorld.get(world)
  if (!m) {
    m = new Map()
    networksByWorld.set(world, m)
  }
  return m
}

/** Iterate every network on this world. */
export const getNetworks = (world: World): Map<string, Network> => registryFor(world)

/** Get a network by id, if one exists. */
export const getNetwork = (world: World, id: string): Network | undefined => registryFor(world).get(id)

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export const DEFAULT_NETWORK_ID = 'default'

export interface AddNetworkOptions {
  /** Stable id. It serves as the key in the network registry of the world. */
  id: string
}

/** Add a network to a world. The function throws when a network with the same
 *  id already exists. */
export const addNetwork = (world: World, options: AddNetworkOptions): Network => {
  const registry = registryFor(world)
  if (registry.has(options.id)) {
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
  registry.set(options.id, network)
  return network
}

/** Remove a network from a world, and close its connections. */
export const removeNetwork = (world: World, id: string): void => {
  const registry = registryFor(world)
  const network = registry.get(id)
  if (!network) return
  network.close()
  registry.delete(id)
}

/** Get the default network, and create it lazily when it does not exist. A
 *  single-network flow uses this function. */
export const ensureDefaultNetwork = (world: World): Network => {
  const existing = getNetwork(world, DEFAULT_NETWORK_ID)
  if (existing) return existing
  return addNetwork(world, { id: DEFAULT_NETWORK_ID })
}

// Cleanup hook. When the engine destroys a world, close its networks and drop them.
onWorldDestroy((world) => {
  const registry = networksByWorld.get(world)
  if (!registry) return
  for (const network of registry.values()) network.close()
  networksByWorld.delete(world)
})
