/**
 * Network — sync topology + per-world registry.
 *
 * A `Network` is a connection set + outbound publish hooks + an inbound
 * governance gate. Many networks per world for spatial segmentation, voice /
 * video channels, etc. The world's event log is canonical; networks don't
 * have their own histories. A mutation is routed to one or more networks by
 * the mutation pipeline (today: broadcast to all). Connections in each
 * network ship the same events through their own underlying transports.
 *
 * Networks live in a per-world registry keyed off `WeakMap<World, …>` rather
 * than as a field on `World` itself — networking is a network-layer concern,
 * and `ecs/world.ts` shouldn't name it.
 */

import type { AuthoredEnvelope, AuthoredEvent, Entity, World } from '../ecs/world'
import { onWorldDestroy } from '../ecs/world'
import type { TransportChannel } from './transport'

// ── Connection ────────────────────────────────────────────────────────────────

/**
 * A live transport link to a peer, scoped to ONE Network. The pair of
 * channels exposed by the underlying `TransportEndpoint` plus session-level
 * metadata (remoteDID, local peer entity once known).
 *
 *   - `connection.events.send(envelope|controlMessage)` — reliable, ordered.
 *   - `connection.stream.send(arrayBuffer)`             — binary runtime packets.
 *
 * Two peers may have multiple Connections between them — one per Network the
 * pair share. Whether multiple Networks share a single underlying transport
 * is a transport-layer concern; the engine doesn't track it.
 */
export interface Connection {
  peer: Entity
  /** Remote agent DID — `'did:unknown:pending'` until the hello is received. */
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
  /** Inbound governance gate. Returning false drops the event. */
  validateAuthored?: (event: AuthoredEvent) => boolean
  /** Close every connection and tear down per-network state. */
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
  /** Stable id. Used as the key in the world's network registry. */
  id: string
}

/** Add a network to a world. Throws if a network with the same id already exists. */
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

/** Remove a network from a world, closing its connections. */
export const removeNetwork = (world: World, id: string): void => {
  const registry = registryFor(world)
  const network = registry.get(id)
  if (!network) return
  network.close()
  registry.delete(id)
}

/** Get (or lazily create) the default network. Used by single-network flows. */
export const ensureDefaultNetwork = (world: World): Network => {
  const existing = getNetwork(world, DEFAULT_NETWORK_ID)
  if (existing) return existing
  return addNetwork(world, { id: DEFAULT_NETWORK_ID })
}

// Cleanup hook — when a world is destroyed, close + drop its networks.
onWorldDestroy((world) => {
  const registry = networksByWorld.get(world)
  if (!registry) return
  for (const network of registry.values()) network.close()
  networksByWorld.delete(world)
})
