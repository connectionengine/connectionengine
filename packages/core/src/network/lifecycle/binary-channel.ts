/**
 * Binary runtime channel for one connection.
 *
 * It owns one BinaryPipeline, which carries its own shadow map and therefore
 * keeps an independent delivery state per peer. It also owns one
 * RemoteBindingTable, which maps the networkId of the peer to a local entity.
 *
 * Outbound flow, on each `publishRuntime(dirty)`:
 *   1. Allocate a local networkId for each entity that became dirty.
 *   2. Send a `{type:'bind'}` control with the bindings that this peer has not
 *      seen yet.
 *   3. Encode the binary packet, and send it.
 *
 * Inbound flow:
 *   1. `{type:'bind'}` → register the entries in the remote table.
 *   2. ArrayBuffer  → call pipeline.read with
 *      `(networkId) => remoteTable.resolve(world, id)`.
 *
 * The per-component throttling and the full-sync intervals come from the
 * `RuntimeTransportConfig[]` of the world. See `network/transport.ts`.
 */

import type { Entity, World } from '../../ecs/world'
import type { ComponentDefinition } from '../../ecs/component'
import type { Connection } from '../network'
import type { BinaryEntry, BinaryPipeline } from '../binary'
import { createBinaryPipeline } from '../binary'
import type { RuntimeTransportConfig } from '../transport'
import { resolveRuntimeConfig } from '../transport'
import {
  createRemoteBindingTable,
  getNetworkIdTable,
  type NetworkIdBinding,
  type RemoteBindingTable
} from './network-id'

export interface BindControlMessage {
  type: 'bind'
  bindings: NetworkIdBinding[]
}

export const isBindControl = (payload: unknown): payload is BindControlMessage =>
  !!payload &&
  typeof payload === 'object' &&
  (payload as { type?: unknown }).type === 'bind' &&
  Array.isArray((payload as { bindings?: unknown }).bindings)

export interface ChannelOptions {
  /** Runtime components, in wire order. Both peers must use the same order. */
  components: readonly ComponentDefinition[]
  /** Optional per-component throttle, and the full-sync schedule. */
  configs?: RuntimeTransportConfig[]
}

export interface BinaryChannel {
  /** Encode the dirty map, and send it across this connection. The function
   *  does nothing when the map holds no relevant component. */
  publish(dirty: Map<string, Set<Entity>>): void
  /** Apply a received binary packet to the world. */
  applyBuffer(buffer: ArrayBuffer): void
  /** Apply an incoming bindings control. */
  registerBindings(bindings: readonly NetworkIdBinding[]): void
  /** Force a full-state snapshot on the next publish. */
  resetShadow(): void
  /** Send the full state of the bindings known now. This seeds a fresh peer. */
  sendInitialFullSync(): void
  readonly remoteTable: RemoteBindingTable
}

/**
 * Internal state for one channel. The public type above stays narrow.
 */
interface ChannelState {
  pipeline: BinaryPipeline
  notified: Set<number>
  fullSyncCountdown: Map<string, number>
  publishCountdown: Map<string, number>
  resolvedConfig: Map<string, Required<RuntimeTransportConfig>>
}

export const createBinaryChannel = (world: World, connection: Connection, options: ChannelOptions): BinaryChannel => {
  const components = options.components
  const localTable = getNetworkIdTable(world)
  const remoteTable = createRemoteBindingTable()

  const state: ChannelState = {
    pipeline: createBinaryPipeline(world, components),
    notified: new Set(),
    fullSyncCountdown: new Map(),
    publishCountdown: new Map(),
    resolvedConfig: new Map()
  }

  const simRate = world.engine.fixedTimeStep > 0 ? 1 / world.engine.fixedTimeStep : 60
  for (const component of components) {
    const cfg = resolveRuntimeConfig(options.configs ?? [], component, simRate)
    state.resolvedConfig.set(component.$id, cfg)
    state.fullSyncCountdown.set(component.$id, cfg.fullSyncInterval)
    state.publishCountdown.set(component.$id, 0)
  }

  /**
   * Choose which dirty entries may go out on this tick, after the per-component
   * publish rate applies. The channel defers every component that sits above
   * its rate cap. The caller has already drained the dirty map, and
   * flushRuntime clears it, so the countdown alone holds the deferral. This is
   * therefore advisory throttling, applied per tick.
   */
  const eligibleEntries = (dirty: Map<string, Set<Entity>>): { entries: BinaryEntry[]; forceFull: boolean } => {
    const entries: BinaryEntry[] = []
    let forceFull = false
    for (const [componentId, entities] of dirty) {
      const cfg = state.resolvedConfig.get(componentId)
      if (!cfg) continue
      // Decrement the publish countdown. Defer the entries of this component
      // while it stays above its rate.
      const countdown = state.publishCountdown.get(componentId) ?? 0
      if (countdown > 0) {
        state.publishCountdown.set(componentId, countdown - 1)
        continue
      }
      // Reset the publish countdown from the rate. A rate at or above the
      // simulation tick rate publishes every tick. Half that rate doubles the
      // skip.
      const skipTicks = cfg.rate > 0 ? Math.max(0, Math.floor(simRate / cfg.rate) - 1) : 0
      state.publishCountdown.set(componentId, skipTicks)
      // Full-sync countdown. It schedules a forced snapshot every N ticks.
      const fsLeft = (state.fullSyncCountdown.get(componentId) ?? cfg.fullSyncInterval) - 1
      if (fsLeft <= 0) {
        forceFull = true
        state.fullSyncCountdown.set(componentId, cfg.fullSyncInterval)
      } else {
        state.fullSyncCountdown.set(componentId, fsLeft)
      }
      for (const entity of entities) {
        const networkId = localTable.ensureFor(entity)
        if (networkId === undefined) continue
        entries.push({ networkId, entity })
      }
    }
    return { entries, forceFull }
  }

  const sendBindingsControl = (entries: readonly BinaryEntry[]): void => {
    const newBindings: NetworkIdBinding[] = []
    for (const entry of entries) {
      if (state.notified.has(entry.networkId)) continue
      state.notified.add(entry.networkId)
      const binding = localTable.bindings().find((b) => b.networkId === entry.networkId)
      if (binding) newBindings.push(binding)
    }
    if (newBindings.length === 0) return
    const msg: BindControlMessage = { type: 'bind', bindings: newBindings }
    connection.events.send(msg)
  }

  return {
    publish(dirty) {
      if (components.length === 0) return
      const { entries, forceFull } = eligibleEntries(dirty)
      if (entries.length === 0) return
      sendBindingsControl(entries)
      const buffer = state.pipeline.write({ fromPeerIndex: 0, timestamp: world.engine.clock.now() }, entries, forceFull)
      // Skip a header-only packet. It carries nothing to deliver.
      if (buffer.byteLength <= HEADER_BYTES) return
      connection.stream.send(buffer)
    },

    applyBuffer(buffer) {
      state.pipeline.read(buffer, (networkId) => remoteTable.resolve(world, networkId))
    },

    registerBindings(bindings) {
      for (const b of bindings) remoteTable.register(b)
    },

    resetShadow() {
      state.pipeline.resetShadow()
      state.notified.clear()
    },

    sendInitialFullSync() {
      // Seed this peer with the current bindings. The next publish then carries
      // the SoA snapshots themselves.
      const all = localTable.bindings()
      if (all.length === 0) return
      for (const b of all) state.notified.add(b.networkId)
      const msg: BindControlMessage = { type: 'bind', bindings: all }
      connection.events.send(msg)
    },

    remoteTable
  }
}

const HEADER_BYTES = 4 + 8 + 4 // fromPeerIndex + timestamp + entityCount
