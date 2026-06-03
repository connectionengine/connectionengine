/**
 * Per-connection binary runtime channel.
 *
 * Owns one BinaryPipeline (with its own shadow map — independent delivery
 * state per peer) and one RemoteBindingTable (peer's networkId → local
 * entity).
 *
 * Outbound flow on each `publishRuntime(dirty)`:
 *   1. Allocate local networkIds for any newly-dirty entities.
 *   2. Send a `{type:'bind'}` control with bindings this peer hasn't seen yet.
 *   3. Encode + send the binary packet.
 *
 * Inbound flow:
 *   1. `{type:'bind'}` → register entries in the remote table.
 *   2. ArrayBuffer  → pipeline.read with `(networkId) => remoteTable.resolve(world, id)`.
 *
 * Per-component throttling + full-sync intervals come from the world's
 * `RuntimeTransportConfig[]` (see `network/transport.ts`).
 */

import type { Connection, Entity, World } from '../../ecs/world'
import type { ComponentDefinition } from '../../ecs/component'
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
  /** Runtime components in wire order. Must match between both peers. */
  components: readonly ComponentDefinition[]
  /** Optional per-component throttle + full-sync schedule. */
  configs?: RuntimeTransportConfig[]
}

export interface BinaryChannel {
  /** Encode + send the dirty map across this connection. No-op if no relevant components. */
  publish(dirty: Map<string, Set<Entity>>): void
  /** Apply a received binary packet into the world. */
  applyBuffer(buffer: ArrayBuffer): void
  /** Apply an incoming bindings control. */
  registerBindings(bindings: readonly NetworkIdBinding[]): void
  /** Force a full-state snapshot on the next publish. */
  resetShadow(): void
  /** Send full state of currently-known bindings (used to seed a fresh peer). */
  sendInitialFullSync(): void
  readonly remoteTable: RemoteBindingTable
}

/**
 * Internal per-channel state. Public type kept narrow above.
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

  for (const component of components) {
    const cfg = resolveRuntimeConfig(options.configs ?? [], component)
    state.resolvedConfig.set(component.id, cfg)
    state.fullSyncCountdown.set(component.id, cfg.fullSyncInterval)
    state.publishCountdown.set(component.id, 0)
  }

  /**
   * Choose which dirty entries are eligible to ship this tick after applying
   * the per-component publish rate. Components above their rate cap are
   * deferred (their dirty entries remain in the world's dirty map for the
   * next flush — but since flushRuntime clears, we keep them locally via the
   * countdown only; the caller already drained the dirty map so this is
   * advisory throttling per tick).
   */
  const eligibleEntries = (dirty: Map<string, Set<Entity>>): { entries: BinaryEntry[]; forceFull: boolean } => {
    const entries: BinaryEntry[] = []
    let forceFull = false
    for (const [componentId, entities] of dirty) {
      const cfg = state.resolvedConfig.get(componentId)
      if (!cfg) continue
      // Decrement publish countdown; defer this component's entries when above rate.
      const countdown = state.publishCountdown.get(componentId) ?? 0
      if (countdown > 0) {
        state.publishCountdown.set(componentId, countdown - 1)
        continue
      }
      // Reset publish countdown based on rate. 60Hz = every tick; 30Hz = every other; etc.
      const baseRate = 60
      const skipTicks = cfg.rate > 0 ? Math.max(0, Math.floor(baseRate / cfg.rate) - 1) : 0
      state.publishCountdown.set(componentId, skipTicks)
      // Full-sync countdown — schedule a forced snapshot every N ticks.
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
      const buffer = state.pipeline.write({ fromPeerIndex: 0, timestamp: world.clock.now() }, entries, forceFull)
      // Skip pure-header packets — nothing to deliver.
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
      // Seed this peer with our current bindings; the next publish will then
      // include the actual SoA snapshots.
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
