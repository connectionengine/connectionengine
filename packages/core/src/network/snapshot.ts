/**
 * Snapshot — a point-in-time capture, and the apply path for it.
 *
 * The capture holds the world state as a structured, JSON-serialisable object.
 * Any transport can therefore carry it. A receiver can apply it again to
 * bootstrap a late-joining peer, or to roll back to a checkpoint.
 *
 * Strategy: walk every named entity of the engine of this world, which means
 * every entry in `uidOfFor(engine)`. Serialise the components and the outgoing
 * relations of each one. The apply path then rebuilds the entity graph from
 * nothing, through `ensureEntityPath`, which chains `resolveEntityPath` and
 * `setUID`. It remaps the entity IDs automatically, and needs no idMap
 * parameter.
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
  /** A map from componentId to the serialised value. */
  components: Record<string, unknown>
  /** A map from relationName to the list of target paths. */
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
  /** Include only the entities that match these component ids. */
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
  /** Remove every existing named entity before the apply. It defaults to false,
   *  which merges instead. */
  replace?: boolean
  /**
   * The sender of this snapshot. Supply it for anything that arrives over the
   * wire. Each component and relation then passes the same two gates that an
   * authored event passes: the `validateAuthored` gate of the network, and the
   * standing check that guards `AuthoritativeFor`. The apply path skips a
   * rejected write instead of applying it.
   *
   * Omit it for a trusted local apply, as in persistence, rollback, or
   * hot-reload.
   */
  from?: SnapshotOrigin
}

export interface SnapshotOrigin {
  /** The DID credited as the author of the writes in the snapshot. */
  author: string
  /** The network whose `validateAuthored` gate applies. */
  network?: Network
}

export const applySnapshot = (world: World, snapshot: Snapshot, options: ApplySnapshotOptions = {}): void => {
  if (options.replace) {
    const named = Array.from(uidOfFor(world.engine).keys())
    for (const e of named) removeEntity(world, e)
  }
  const admit = admitter(world, snapshot, options.from)
  // Pass 1: the entity graph. It holds every path, with its UID and its parent
  // chain. This graph is the addressing substrate that the later passes resolve
  // against, and that the networkId bindings of the binary channel resolve
  // against. The pass therefore lays it down whole and ungated, exactly as an
  // authored event materialises its own entity path.
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
  // Pass 3: relations. Every entity exists by now, so every target resolves.
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
 * Build the predicate that decides whether one write from a snapshot may land.
 * The builder expresses each write as the `AuthoredEvent` that would have
 * carried it. The gates therefore see exactly what they see on the authored
 * path: the same author, the same predicate, and the same value shape. Without
 * an origin, the predicate admits everything.
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

// The component and relation enumeration uses worldComponents and
// worldRelations from mutation.ts.
