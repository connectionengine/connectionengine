/**
 * NetworkId table — entity ↔ compact integer mapping for the binary wire.
 *
 * The binary runtime codec writes `u32 networkId` per entity rather than the
 * full string entity path. Each side independently allocates networkIds for
 * its own entities and ships the (networkId → entityPath) bindings to peers
 * as control messages before the first binary packet that references them.
 *
 * The table is intentionally per-world: networkIds are local labels for local
 * entities. Per-connection tracking of "which bindings has this peer been
 * told about" lives separately in `binary-channel.ts` so each peer can be
 * informed lazily on first dirty.
 */

import type { Entity, World } from '../../ecs/world'
import { getEntityPath } from '../../ecs/identity'

export interface NetworkIdBinding {
  networkId: number
  entityPath: string[]
}

export interface NetworkIdTable {
  /** Allocate (or return existing) networkId for a local entity that has an addressable path. */
  ensureFor(entity: Entity): number | undefined
  /** Networked id for an entity, or undefined if unallocated. */
  idOf(entity: Entity): number | undefined
  /** Local entity for a previously-allocated id, or undefined. */
  entityOf(networkId: number): Entity | undefined
  /** Snapshot every existing (networkId → entityPath) binding. */
  bindings(): NetworkIdBinding[]
}

const tables = new WeakMap<World, NetworkIdTable>()

/** Get-or-create the per-world local NetworkIdTable. */
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
    }
  }
  tables.set(world, table)
  return table
}

/**
 * Remote-binding registry — for inbound packets, maps the peer's networkIds
 * to local entity paths. Looked up by the binary reader's resolver.
 *
 * Per-connection rather than per-world: two different peers may use the same
 * networkId for different entities.
 */
export interface RemoteBindingTable {
  register(binding: NetworkIdBinding): void
  /** Resolve incoming networkId → local entity (or undefined if unknown / not yet present). */
  resolve(world: World, networkId: number): Entity | undefined
  /** Snapshot for debug / inspection. */
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
      // Walk path through the world's identity cache. We do NOT auto-create —
      // the entity must exist (typically established via prior authored event).
      let parent: Entity = world.worldRoot
      let cursor: Entity | undefined = undefined
      for (const uid of path) {
        cursor = world.nameCache.get(parent)?.get(uid)
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
