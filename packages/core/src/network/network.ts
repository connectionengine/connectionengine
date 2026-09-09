/**
 * Network — the sync topology of a world.
 *
 * A `Network` is a set of connections plus four behaviours. The behaviours
 * decide what happens on those connections:
 *
 *   - how an authored envelope goes out
 *   - how a binary delta goes out
 *   - which inbound event the network admits
 *   - what to report about an event it refuses
 *
 * **The behaviours are fixed when the network is built.** They are readonly
 * fields, supplied to `addNetwork` and never reassigned.
 *
 * A mutable hook would make the answer to "what does this network do with an
 * envelope?" depend on when you ask, and on whichever module wrote to the
 * field last. That gives behaviour a second source of truth, which a reader
 * can find only by a search for assignments. Fixed fields make the pattern
 * unavailable.
 *
 * Callers never reach for the fields. They call the module-level functions
 * below — `publishAuthored(world, network, envelope)` and friends — which take
 * the network as an argument and dispatch to whatever it was built with. One
 * calling convention, one place the defaults live.
 *
 * The networks themselves live on `world.networks`. This module holds the
 * operations. The world holds the state, so `destroyWorld` clears its own field
 * rather than each layer keeping a side table of its own.
 */

import type { AuthoredEnvelope, AuthoredEvent, Entity, World } from '../ecs/world'
import type { Connection } from './transport'

// ── Behaviours ───────────────────────────────────────────────────────────────-

/** Send an authored envelope out over this network. */
export type PublishAuthored = (world: World, network: Network, envelope: AuthoredEnvelope) => void

/** Send a set of dirty runtime entities out over this network. */
export type PublishRuntime = (world: World, network: Network, dirty: Map<string, Set<Entity>>) => void

/** Decide whether an inbound event may be applied. */
export type ValidateAuthored = (world: World, network: Network, event: AuthoredEvent) => boolean

/** Report an inbound event that a gate refused. */
export type ReportRejected = (world: World, network: Network, event: AuthoredEvent, reason: string) => void

// ── Network ──────────────────────────────────────────────────────────────────-

export interface Network {
  readonly id: string
  /** Active peer connections on this network. */
  readonly connections: Set<Connection>
  /** How authored envelopes leave. Defaults to fanning across `connections`. */
  readonly onPublishAuthored: PublishAuthored
  /** How binary deltas leave. Defaults to the binary channel of each connection. */
  readonly onPublishRuntime: PublishRuntime
  /** The inbound gate. Defaults to admitting everything. */
  readonly onValidateAuthored: ValidateAuthored
  /** Diagnostic for a refused event. Unset by default, so refusals are silent
   *  unless someone asks to hear about them. */
  readonly onRejected?: ReportRejected
  /** Close every connection, and release the per-network state. */
  close(): void
}

// ── Defaults ─────────────────────────────────────────────────────────────────-

/** Fan an envelope across every connection on the network. */
const fanoutAuthored: PublishAuthored = (_world, network, envelope) => {
  for (const conn of network.connections) conn.events.send(envelope)
}

/** Hand the dirty set to the binary channel of each connection. */
const fanoutRuntime: PublishRuntime = (_world, network, dirty) => {
  for (const conn of network.connections) conn.channel?.publish(dirty)
}

/** Admit everything. A world that wants governance supplies its own. */
const admitAll: ValidateAuthored = () => true

// ── Dispatch ─────────────────────────────────────────────────────────────────-
//
// The mutation pipeline and the lifecycle call these rather than reaching into
// the network, so the calling convention stays `verb(world, network, …)`
// throughout and the behaviour lookup lives in one place.

export const publishAuthored = (world: World, network: Network, envelope: AuthoredEnvelope): void =>
  network.onPublishAuthored(world, network, envelope)

export const publishRuntime = (world: World, network: Network, dirty: Map<string, Set<Entity>>): void =>
  network.onPublishRuntime(world, network, dirty)

export const validateAuthored = (world: World, network: Network, event: AuthoredEvent): boolean =>
  network.onValidateAuthored(world, network, event)

export const reportRejected = (world: World, network: Network, event: AuthoredEvent, reason: string): void =>
  network.onRejected?.(world, network, event, reason)

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
  /** Override the outbound authored path. `@connectionengine/ad4m-bridge`
   *  supplies one that writes AD4M Links instead of fanning across sockets. */
  onPublishAuthored?: PublishAuthored
  /** Override the outbound binary path. */
  onPublishRuntime?: PublishRuntime
  /** The governance gate. Pass `validateEvent` from `network/governance` to
   *  enforce the constraints that replicate with the world. */
  onValidateAuthored?: ValidateAuthored
  /** Diagnostic for a refused event. */
  onRejected?: ReportRejected
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
    onPublishAuthored: options.onPublishAuthored ?? fanoutAuthored,
    onPublishRuntime: options.onPublishRuntime ?? fanoutRuntime,
    onValidateAuthored: options.onValidateAuthored ?? admitAll,
    onRejected: options.onRejected,
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
 *
 * The options apply only when this call is the one that creates it. Behaviour
 * is fixed at construction, so a second caller cannot change what an existing
 * network does — build a distinct network with `addNetwork` instead.
 */
export const ensureDefaultNetwork = (world: World, options: Omit<AddNetworkOptions, 'id'> = {}): Network => {
  const existing = getNetwork(world, DEFAULT_NETWORK_ID)
  if (existing) return existing
  return addNetwork(world, { ...options, id: DEFAULT_NETWORK_ID })
}
