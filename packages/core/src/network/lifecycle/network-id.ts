/**
 * NetworkId table — a mapping between an entity and a compact integer, for the
 * binary wire.
 *
 * The binary runtime codec writes one `u32 networkId` per entity, instead of
 * the full string entity path. Each side allocates the networkIds of its own
 * entities independently. It then sends the (networkId → entityPath) bindings
 * to its peers as control messages, before the first binary packet that
 * references them.
 *
 * The table stays per-world deliberately, because a networkId is a local label
 * for a local entity. The per-connection record of which bindings a peer has
 * received lives separately, in `binary-channel.ts`, so that each peer learns
 * about a binding lazily, when its entity first becomes dirty.
 */

import type { Entity, World } from '../../ecs/world'
import { getEntityPath, nameCacheFor } from '../../ecs/entity'

export interface NetworkIdBinding {
  networkId: number
  entityPath: string[]
}

export interface NetworkIdTable {
  /** Allocate the networkId of a local entity that holds an addressable path,
   *  or return the existing one. */
  ensureFor(entity: Entity): number | undefined
  /** The network id of an entity. It returns undefined when no id is allocated. */
  idOf(entity: Entity): number | undefined
  /** The local entity of an id allocated earlier. It returns undefined when no
   *  entity matches. */
  entityOf(networkId: number): Entity | undefined
  /** Snapshot every existing (networkId → entityPath) binding. */
  bindings(): NetworkIdBinding[]
  /** The binding for one id. It returns undefined when the id is unallocated,
   *  or when its entity no longer holds an addressable path. */
  bindingFor(networkId: number): NetworkIdBinding | undefined
}

const tables = new WeakMap<World, NetworkIdTable>()

/** Get the local NetworkIdTable of a world, or create it. */
export const getNetworkIdTable = (world: World): NetworkIdTable => {
  const existing = tables.get(world)
  if (existing) return existing
  const entityToId = new Map<Entity, number>()
  const idToEntity = new Map<number, Entity>()
  let nextId = 1 // reserve 0 as "unmapped"
  const table: NetworkIdTable = {
    ensureFor(entity) {
      const existingId = entityToId.get(entity)
      if (existingId !== undefined) return existingId
      const path = getEntityPath(world, entity)
      if (path.length === 0) return undefined
      const id = nextId++
      entityToId.set(entity, id)
      idToEntity.set(id, entity)
      return id
    },
    idOf(entity) {
      return entityToId.get(entity)
    },
    entityOf(networkId) {
      return idToEntity.get(networkId)
    },
    bindings() {
      const out: NetworkIdBinding[] = []
      for (const [entity, id] of entityToId) {
        const path = getEntityPath(world, entity)
        if (path.length > 0) out.push({ networkId: id, entityPath: path })
      }
      return out
    },
    bindingFor(networkId) {
      const entity = idToEntity.get(networkId)
      if (entity === undefined) return undefined
      const path = getEntityPath(world, entity)
      return path.length > 0 ? { networkId, entityPath: path } : undefined
    }
  }
  tables.set(world, table)
  return table
}

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
  /** Resolve an incoming networkId to a local entity. It returns undefined when
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
