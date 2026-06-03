/**
 * Entity Identity — BelongsTo + UIDComponent + O(1) path lookups.
 *
 * Identity composes from two ECS primitives, not a special-purpose system:
 *   - UIDComponent (regular component) carries the entity's UID within its parent.
 *   - BelongsTo (exclusive relation) carries the identity context.
 *
 * Top-level named entities use `world.worldRoot` as their implicit parent for
 * bucket-keying. The (parent → uid → entity) cache is maintained inline by
 * `setUID` and `cleanupIdentity` (called from removeEntity).
 */

import { Schema } from '../schema'
import { defineComponent, getComponent, setComponent } from '../ecs/component'
import { addRelation, defineRelation } from '../ecs/relation'
import type { Entity, World } from '../ecs/world'
import type { Origin } from '../ecs/trace'
import { createEntity, registerRemoveHook } from '../ecs/entity'

// ── Built-in component + relation ─────────────────────────────────────────────

export const UIDComponent = defineComponent({
  id: 'UID',
  label: 'UID',
  schema: Schema.Object({
    value: Schema.String({ default: '' })
  })
})

export const BelongsTo = defineRelation({
  name: 'BelongsTo',
  exclusive: true
})

// ── Internal cache helpers ────────────────────────────────────────────────────

const indexInBucket = (world: World, parent: Entity, uid: string, entity: Entity): void => {
  let bucket = world.nameCache.get(parent)
  if (!bucket) {
    bucket = new Map()
    world.nameCache.set(parent, bucket)
  }
  const existing = bucket.get(uid)
  if (existing !== undefined && existing !== entity) {
    throw new Error(`Duplicate UID '${uid}' under parent ${parent} (existing entity ${existing})`)
  }
  bucket.set(uid, entity)
}

const unindexFromBucket = (world: World, parent: Entity, uid: string): void => {
  const bucket = world.nameCache.get(parent)
  if (!bucket) return
  bucket.delete(uid)
  if (bucket.size === 0) world.nameCache.delete(parent)
}

/** Remove all identity-cache references for an entity. Idempotent. */
export const cleanupIdentity = (world: World, entity: Entity): void => {
  const uid = world.uidOf.get(entity)
  const parent = world.parentOf.get(entity)
  if (uid !== undefined) {
    if (parent !== undefined) unindexFromBucket(world, parent, uid)
    else unindexFromBucket(world, world.worldRoot, uid)
  }
  world.uidOf.delete(entity)
  world.parentOf.delete(entity)
  // If this entity was a parent, drop its bucket too (children's BelongsTo dangles).
  world.nameCache.delete(entity)
}

// Wire entity removal → identity cleanup at module load (avoids import cycle).
registerRemoveHook(cleanupIdentity)

// ── Public identity API ───────────────────────────────────────────────────────

export interface SetUIDOptions {
  parent?: Entity
  /** Mutation origin tag — defaults to 'local' (will replicate). Pass 'network' from the receive path. */
  origin?: Origin
}

/** Assign UID + optional BelongsTo parent. Maintains caches and enforces uniqueness. */
export const setUID = (world: World, entity: Entity, uid: string, options: SetUIDOptions = {}): void => {
  // Resolve effective parent — explicit > existing > worldRoot (implicit top-level).
  const effectiveParent: Entity = options.parent ?? world.parentOf.get(entity) ?? world.worldRoot

  // Collision check
  const existingInBucket = world.nameCache.get(effectiveParent)?.get(uid)
  if (existingInBucket !== undefined && existingInBucket !== entity) {
    throw new Error(`Duplicate UID '${uid}' under parent ${effectiveParent} (existing entity ${existingInBucket})`)
  }

  // Drop previous identity entries for this entity
  const previousUid = world.uidOf.get(entity)
  const previousParent = world.parentOf.get(entity) ?? world.worldRoot
  if (previousUid !== undefined) unindexFromBucket(world, previousParent, previousUid)

  // Write component (instance store value) and relation
  setComponent(world, entity, UIDComponent, { value: uid }, { origin: options.origin })
  world.uidOf.set(entity, uid)

  if (options.parent !== undefined) {
    addRelation(world, entity, BelongsTo, options.parent, { origin: options.origin })
    world.parentOf.set(entity, options.parent)
  }

  // Index under effective parent
  indexInBucket(world, effectiveParent, uid, entity)
}

/** Get UID of an entity. Falls back to reading the component if cache not populated. */
export const getUID = (world: World, entity: Entity): string | undefined =>
  world.uidOf.get(entity) ?? (getComponent(world, entity, UIDComponent) as { value: string } | undefined)?.value

/** Get BelongsTo parent of an entity, if any. */
export const getParent = (world: World, entity: Entity): Entity | undefined => world.parentOf.get(entity)

/** O(1) lookup: find entity by UID under a parent. Use `world.worldRoot` for top-level. */
export const getEntityByUID = (world: World, parent: Entity, uid: string): Entity | undefined =>
  world.nameCache.get(parent)?.get(uid)

/** Walk BelongsTo chain root→leaf, returning the UID path. */
export const getEntityPath = (world: World, entity: Entity): string[] => {
  const path: string[] = []
  let cursor: Entity | undefined = entity
  while (cursor !== undefined) {
    const uid = world.uidOf.get(cursor)
    if (uid === undefined) break
    path.unshift(uid)
    cursor = world.parentOf.get(cursor)
  }
  return path
}

/** Inverse of getEntityPath — resolve a UID path back to an entity. */
export const resolveEntityPath = (world: World, path: string[]): Entity | undefined => {
  if (path.length === 0) return undefined
  let cursor: Entity | undefined = getEntityByUID(world, world.worldRoot, path[0])
  for (let i = 1; cursor !== undefined && i < path.length; i++) {
    cursor = getEntityByUID(world, cursor, path[i])
  }
  return cursor
}

/** Create a top-level entity with a UID. Equivalent to createEntity + setUID with no parent. */
export const createNamedEntity = (world: World, uid: string): Entity => {
  const e = createEntity(world)
  setUID(world, e, uid)
  return e
}
