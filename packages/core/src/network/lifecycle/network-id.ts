/**
 * NetworkId — a compact integer label for an entity on the binary wire.
 *
 * The binary runtime codec writes one `u32 networkId` per entity, instead of
 * the full string entity path. Each side allocates the networkIds of its own
 * entities independently. It then sends the (networkId → entityPath) bindings
 * to its peers as control messages, before the first binary packet that
 * references them.
 *
 * The local id lives as a `NetworkId` component on the entity itself. The ECS
 * owns the lifecycle — when an entity is destroyed, the component goes with it.
 * The counter lives on `world.nextNetworkId`.
 *
 * The per-connection record of which bindings a peer has received lives
 * separately, in `binary-channel.ts`, so that each peer learns about a binding
 * lazily, when its entity first becomes dirty.
 */

import { Schema } from '../../schema'
import { defineComponent, getComponent, setComponent } from '../../ecs/component'
import { query } from '../../ecs/query'
import { getEntityPath, nameCacheFor } from '../../ecs/entity'
import type { Entity, World } from '../../ecs/world'

// ── Component ───────────────────────────────────────────────────────────────-

export const NetworkIdComponent = defineComponent({
  id: 'NetworkId',
  label: 'NetworkId',
  sync: false,
  schema: Schema.Object({
    id: Schema.Number({ default: 0 })
  })
})

// ── Binding type ────────────────────────────────────────────────────────────-

export interface NetworkIdBinding {
  networkId: number
  entityPath: string[]
}

// ── Local helpers ───────────────────────────────────────────────────────────-

/**
 * Assign a networkId to a local entity that holds an addressable path, or
 * return the existing one. Returns undefined when the entity has no UID path.
 */
export const ensureNetworkId = (world: World, entity: Entity): number | undefined => {
  const existing = getComponent(world, entity, NetworkIdComponent) as { id?: number } | undefined
  if (existing?.id) return existing.id
  const path = getEntityPath(world, entity)
  if (path.length === 0) return undefined
  const id = world.nextNetworkId++
  setComponent(world, entity, NetworkIdComponent, { id }, { origin: 'local' })
  return id
}

/** Read the networkId of an entity. Returns undefined when none is assigned. */
export const getNetworkId = (world: World, entity: Entity): number | undefined => {
  const value = getComponent(world, entity, NetworkIdComponent) as { id?: number } | undefined
  return value?.id
}

/** Snapshot every existing (networkId → entityPath) binding. */
export const networkIdBindings = (world: World): NetworkIdBinding[] => {
  const out: NetworkIdBinding[] = []
  for (const entity of query(world, [NetworkIdComponent])) {
    const value = getComponent(world, entity, NetworkIdComponent) as { id: number }
    const path = getEntityPath(world, entity)
    if (path.length > 0) out.push({ networkId: value.id, entityPath: path })
  }
  return out
}

// ── Remote binding table ────────────────────────────────────────────────────-

/**
 * Remote-binding registry. For an inbound packet, it maps the networkIds of the
 * peer to local entity paths. The resolver of the binary reader looks the
 * entries up.
 *
 * It stays per-connection rather than per-world, because two different peers
 * can use the same networkId for different entities.
 */
export interface RemoteBindingTable {
  register(binding: NetworkIdBinding): void
  /** Resolve an incoming networkId to a local entity. Returns undefined when
   *  the id is unknown, or when the entity does not exist yet. */
  resolve(world: World, networkId: number): Entity | undefined
  /** Snapshot the table, for debugging and inspection. */
  entries(): NetworkIdBinding[]
}

export const createRemoteBindingTable = (): RemoteBindingTable => {
  const byId = new Map<number, string[]>()
  return {
    register(binding) {
      byId.set(binding.networkId, binding.entityPath)
    },
    resolve(world, networkId) {
      const path = byId.get(networkId)
      if (!path) return undefined
      // Walk the path through the identity cache of the world. The resolver
      // does NOT create an entity. The entity must exist already, and an
      // earlier authored event usually establishes it.
      let parent: Entity = world.worldRoot
      let cursor: Entity | undefined = undefined
      for (const uid of path) {
        cursor = nameCacheFor(world.engine).get(parent)?.get(uid)
        if (cursor === undefined) return undefined
        parent = cursor
      }
      return cursor
    },
    entries() {
      const out: NetworkIdBinding[] = []
      for (const [networkId, entityPath] of byId) out.push({ networkId, entityPath })
      return out
    }
  }
}
