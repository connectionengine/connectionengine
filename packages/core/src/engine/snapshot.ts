/**
 * Snapshot — point-in-time capture + apply.
 *
 * Captures world state as a structured (JSON-serialisable) object so it can be
 * shipped over any transport and reapplied to bootstrap a late-joining peer or
 * roll back to a checkpoint.
 *
 * Strategy: walk every named entity (entries in world.uidOf), serialise its
 * components + outgoing relations. Apply rebuilds the entity graph from
 * scratch via ensureEntityPath (resolveEntityPath + setUID chain) so entity
 * IDs are remapped automatically — no idMap parameter required.
 */

import { getComponent, getComponentById, hasComponent, setComponent } from '../ecs/component'
import { ROOT_PARENT, getEntityByUID, getEntityPath, setUID } from '../network/identity'
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
  const componentDefs = worldComponents(world)
  const relationDefs = worldRelations(world)
  const seenComponents = new Set<string>()

  for (const entity of world.uidOf.keys()) {
    const path = getEntityPath(world, entity)
    if (path.length === 0) continue
    const components: Record<string, unknown> = {}
    const relations: Record<string, string[][]> = {}
    for (const def of componentDefs) {
      if (!hasComponent(world, entity, def)) continue
      if (includeIds && !includeIds.has(def.id)) continue
      const value = getComponent(world, entity, def)
      // Convert typed arrays to plain arrays for JSON serialisation
      components[def.id] = serialiseValue(value)
      seenComponents.add(def.id)
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

  world.trace.emit({ kind: 'snapshot.create', ts: world.clock.now(), detail: { entityCount: entities.length } })

  return {
    metadata: {
      simulationTime: world.simulationTime,
      timestamp: world.clock.now(),
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
    const named = Array.from(world.uidOf.keys())
    for (const e of named) removeEntity(world, e, { silent: true })
  }
  // Resolve component / relation definitions — prefer this world's pipeline
  // registry, fall back to the global definition registry (so applySnapshot
  // can rebuild components that haven't been touched on this world yet).
  const resolveComponent = (id: string) => worldComponents(world).find((c) => c.id === id) ?? getComponentById(id)
  const resolveRelation = (name: string) =>
    worldRelations(world).find((r) => r.name === name) ?? getRelationByName(name)

  // Pass 1: ensure all entities exist with their UID + parent chain
  for (const ent of snapshot.entities) ensureEntityPath(world, ent.path)
  // Pass 2: apply components
  for (const ent of snapshot.entities) {
    const entity = ensureEntityPath(world, ent.path)
    for (const [componentId, value] of Object.entries(ent.components)) {
      const def = resolveComponent(componentId)
      if (!def) continue
      setComponent(world, entity, def, value as Record<string, unknown>, { origin: 'network' })
    }
  }
  // Pass 3: apply relations (entities all exist now)
  for (const ent of snapshot.entities) {
    const entity = ensureEntityPath(world, ent.path)
    for (const [relName, targetPaths] of Object.entries(ent.relations)) {
      const rel = resolveRelation(relName)
      if (!rel) continue
      for (const targetPath of targetPaths) {
        const target = ensureEntityPath(world, targetPath)
        addRelation(world, entity, rel, target, { origin: 'network' })
      }
    }
  }

  world.trace.emit({
    kind: 'snapshot.apply',
    ts: world.clock.now(),
    detail: { entityCount: snapshot.entities.length, components: snapshot.metadata.components }
  })
}

// ── helpers ───────────────────────────────────────────────────────────────────

const ensureEntityPath = (world: World, path: string[]): Entity => {
  let parent: Entity = ROOT_PARENT
  let cursor: Entity = ROOT_PARENT
  for (const uid of path) {
    const existing = getEntityByUID(world, parent, uid)
    if (existing !== undefined) {
      cursor = existing
    } else {
      cursor = createEntity(world, { silent: true })
      if (parent === ROOT_PARENT) setUID(world, cursor, uid, { origin: 'network' })
      else setUID(world, cursor, uid, { parent, origin: 'network' })
    }
    parent = cursor
  }
  return cursor
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
