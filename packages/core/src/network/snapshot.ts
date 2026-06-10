/**
 * Snapshot — point-in-time capture + apply.
 *
 * Captures world state as a structured (JSON-serialisable) object so it can be
 * shipped over any transport and reapplied to bootstrap a late-joining peer or
 * roll back to a checkpoint.
 *
 * Strategy: walk every named entity for this world's engine (entries in
 * `uidOfFor(engine)`), serialise its components + outgoing relations. Apply
 * rebuilds the entity graph from scratch via ensureEntityPath
 * (resolveEntityPath + setUID chain) so entity IDs are remapped automatically
 * — no idMap parameter required.
 */

import type { ComponentDefinition } from '../ecs/component'
import { getComponent, getComponentById, hasComponent, setComponent } from '../ecs/component'
import { getEntityByUID, getEntityPath, setUID, uidOfFor } from '../ecs/entity'
import { addRelation, getRelationByName, getRelationTargets } from '../ecs/relation'
import { createEntity, removeEntity } from '../ecs/entity'
import { worldComponents, worldRelations } from './mutation'
import type { Entity, World } from '../ecs/world'

export interface SnapshotEntity {
  path: string[]
  /** componentId → serialised value */
  components: Record<string, unknown>
  /** relationName → list of target paths */
  relations: Record<string, string[][]>
}

export interface SnapshotMetadata {
  simulationTime: number
  timestamp: number
  entityCount: number
  components: string[]
}

export interface Snapshot {
  metadata: SnapshotMetadata
  entities: SnapshotEntity[]
}

export interface CreateSnapshotOptions {
  /** Only include entities matching these component ids. */
  filter?: string[]
}

export const createSnapshot = (world: World, options: CreateSnapshotOptions = {}): Snapshot => {
  const entities: SnapshotEntity[] = []
  const includeIds = options.filter ? new Set(options.filter) : undefined
  const componentDefs = worldComponents()
  const relationDefs = worldRelations()
  const seenComponents = new Set<string>()

  for (const entity of uidOfFor(world.engine).keys()) {
    const path = getEntityPath(world, entity)
    if (path.length === 0) continue
    const components: Record<string, unknown> = {}
    const relations: Record<string, string[][]> = {}
    for (const def of componentDefs) {
      if (!hasComponent(world, entity, def)) continue
      if (includeIds && !includeIds.has(def.$id)) continue
      components[def.$id] = serialiseComponent(world, entity, def)
      seenComponents.add(def.$id)
    }
    for (const rel of relationDefs) {
      const targets = getRelationTargets(world, entity, rel)
      if (targets.length === 0) continue
      const targetPaths: string[][] = []
      for (const target of targets) {
        const tPath = getEntityPath(world, target)
        if (tPath.length > 0) targetPaths.push(tPath)
      }
      if (targetPaths.length > 0) relations[rel.name] = targetPaths
    }
    entities.push({ path, components, relations })
  }

  return {
    metadata: {
      simulationTime: world.engine.simulationTime,
      timestamp: world.engine.clock.now(),
      entityCount: entities.length,
      components: Array.from(seenComponents)
    },
    entities
  }
}

export interface ApplySnapshotOptions {
  /** Clear all existing named entities before applying. Default false (merge). */
  replace?: boolean
}

export const applySnapshot = (world: World, snapshot: Snapshot, options: ApplySnapshotOptions = {}): void => {
  if (options.replace) {
    const named = Array.from(uidOfFor(world.engine).keys())
    for (const e of named) removeEntity(world, e)
  }
  // Pass 1: ensure all entities exist with their UID + parent chain
  for (const ent of snapshot.entities) ensureEntityPath(world, ent.path)
  // Pass 2: apply components
  for (const ent of snapshot.entities) {
    const entity = ensureEntityPath(world, ent.path)
    for (const [componentId, value] of Object.entries(ent.components)) {
      const def = getComponentById(componentId)
      if (!def) continue
      setComponent(world, entity, def, value as Record<string, unknown>, { origin: 'network' })
    }
  }
  // Pass 3: apply relations (entities all exist now)
  for (const ent of snapshot.entities) {
    const entity = ensureEntityPath(world, ent.path)
    for (const [relName, targetPaths] of Object.entries(ent.relations)) {
      const rel = getRelationByName(relName)
      if (!rel) continue
      for (const targetPath of targetPaths) {
        const target = ensureEntityPath(world, targetPath)
        addRelation(world, entity, rel, target, { origin: 'network' })
      }
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

const ensureEntityPath = (world: World, path: string[]): Entity => {
  let parent: Entity = world.worldRoot
  let cursor: Entity = world.worldRoot
  for (const uid of path) {
    const existing = getEntityByUID(world, parent, uid)
    if (existing !== undefined) {
      cursor = existing
    } else {
      cursor = createEntity(world)
      if (parent === world.worldRoot) setUID(world, cursor, uid, { origin: 'network' })
      else setUID(world, cursor, uid, { parent, origin: 'network' })
    }
    parent = cursor
  }
  return cursor
}

interface SoAToable {
  to?: (entity: number) => ArrayLike<number>
}

/**
 * Serialise a single component to a JSON-safe value. SoA fields are read
 * straight from the definition's SoA stores into plain arrays; value fields
 * come from the engine's instance store via `getComponent`.
 */
const serialiseComponent = (world: World, entity: number, def: ComponentDefinition): unknown => {
  if (def.$soaFields.length === 0) {
    return serialiseValue(getComponent(world, entity, def))
  }
  const out: Record<string, unknown> = {}
  for (const field of def.$soaFields) {
    const soa = def[field] as SoAToable | undefined
    if (soa && typeof soa.to === 'function') {
      out[field] = Array.from(soa.to(entity))
    }
  }
  return out
}

const serialiseValue = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>)
  if (Array.isArray(value)) return value.map(serialiseValue)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = serialiseValue(v)
  return out
}

// Component/relation enumeration uses worldComponents/worldRelations from mutation.ts.
