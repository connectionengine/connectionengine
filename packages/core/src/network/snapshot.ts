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

import { getComponentById, hasComponent, serialiseComponentValue, setComponent } from '../ecs/component'
import { getEntityByUID, getEntityPath, setUID, uidOfFor } from '../ecs/entity'
import { addRelation, getRelationByName, getRelationTargets } from '../ecs/relation'
import { createEntity, removeEntity } from '../ecs/entity'
import { worldComponents, worldRelations } from './mutation'
import { checkAuthorityChangeStanding } from './authority'
import type { Network } from './network'
import type { AuthoredEvent, Entity, World } from '../ecs/world'

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
      components[def.$id] = serialiseComponentValue(world, entity, def)
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
  /**
   * Who sent this snapshot. Supply it for anything arriving over the wire: each
   * component and relation then passes the same two gates an authored event
   * does — the network's `validateAuthored`, and the standing check guarding
   * `AuthoritativeFor` — and rejected writes are skipped, not applied.
   *
   * Omit it for a trusted local apply: persistence, rollback, hot-reload.
   */
  from?: SnapshotOrigin
}

export interface SnapshotOrigin {
  /** DID credited as the author of the snapshot's writes. */
  author: string
  /** Network whose `validateAuthored` gate applies. */
  network?: Network
}

export const applySnapshot = (world: World, snapshot: Snapshot, options: ApplySnapshotOptions = {}): void => {
  if (options.replace) {
    const named = Array.from(uidOfFor(world.engine).keys())
    for (const e of named) removeEntity(world, e)
  }
  const admit = admitter(world, snapshot, options.from)
  // Pass 1: the entity graph — every path, with its UID + parent chain. This is
  // the addressing substrate that the later passes and the binary channel's
  // networkId bindings resolve against, so it is laid down whole and ungated,
  // exactly as an authored event materialises its own entity path.
  for (const ent of snapshot.entities) ensureEntityPath(world, ent.path)
  // Pass 2: components
  for (const ent of snapshot.entities) {
    const entity = ensureEntityPath(world, ent.path)
    for (const [componentId, value] of Object.entries(ent.components)) {
      const def = getComponentById(componentId)
      if (!def || !admit(ent.path, componentId, value)) continue
      setComponent(world, entity, def, value as Record<string, unknown>, { origin: 'network' })
    }
  }
  // Pass 3: relations (every entity exists by now, so targets always resolve)
  for (const ent of snapshot.entities) {
    const entity = ensureEntityPath(world, ent.path)
    for (const [relName, targetPaths] of Object.entries(ent.relations)) {
      const rel = getRelationByName(relName)
      if (!rel) continue
      for (const targetPath of targetPaths) {
        if (!admit(ent.path, relName, { targetPath })) continue
        addRelation(world, entity, rel, ensureEntityPath(world, targetPath), { origin: 'network' })
      }
    }
  }
}

/**
 * Build the predicate deciding whether one of a snapshot's writes may land.
 * Each write is expressed as the `AuthoredEvent` that would have carried it, so
 * the gates see exactly what they see on the authored path — same author, same
 * predicate, same value shape. With no origin, everything is admitted.
 */
const admitter = (
  world: World,
  snapshot: Snapshot,
  from: SnapshotOrigin | undefined
): ((entityPath: string[], predicate: string, value: unknown) => boolean) => {
  if (!from) return () => true
  const gate = from.network?.validateAuthored
  return (entityPath, predicate, value) => {
    const event: AuthoredEvent = {
      entityPath,
      predicate,
      op: 'set',
      value,
      author: from.author,
      timestamp: snapshot.metadata.timestamp
    }
    if (gate && !gate(event)) return false
    return checkAuthorityChangeStanding(world, event) === undefined
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

// Component/relation enumeration uses worldComponents/worldRelations from mutation.ts.
