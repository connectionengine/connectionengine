/**
 * Entity — integer ID + cross-world identity.
 *
 * An entity has two identifiers, and this module maintains both:
 *
 *   - **The integer ID** (`Entity = number`) is a bitECS handle, unique within
 *     one engine's bitECS world. Runtime-local, never sent over the wire,
 *     never stored in user data.
 *   - **The UID path** is the entity's stable cross-world identity — the list
 *     of UIDs walked from a `worldRoot` through `BelongsTo` relations. This
 *     is what authored events carry on the wire.
 *
 * Identity composes from two ECS primitives — `UIDComponent` (string) and
 * `BelongsTo` (exclusive relation) — each carrying its own typed extension
 * caches that keep lookups O(1):
 *
 *   UIDComponent.nameCache : parent → (uid → entity)   for `getEntityByUID`
 *   UIDComponent.uidOf     : entity → uid              for `getUID` + path walking
 *   BelongsTo.parentOf     : child  → parent           for path walking + cache invalidation
 *
 * The caches live ON the definitions (typed extension properties), which is
 * the natural home — they only have meaning *because* of the component /
 * relation they index. `setUID` maintains all three. `removeEntity` clears
 * them inline.
 *
 * For a wire-addressable entity with owner + authority, use `spawnPrefab`
 * from `network/prefab`. This module is the pure-ECS substrate.
 */

import * as bitecs from 'bitecs'
import { Schema } from '../schema'
import { defineComponent, getComponent, setComponent } from './component'
import { addRelation, defineRelation } from './relation'
import type { Engine } from './engine'
import type { Entity, Origin, World } from './world'

export type { Entity } from './world'

// ── Built-in identity component + relation ───────────────────────────────────-
//
// nameCache / uidOf / parentOf are typed extension properties on the relevant
// definitions — they live there because they only index UIDs / BelongsTo
// edges, and there's no other place where they meaningfully exist. Component
// and relation definitions are module-level singletons, so the *extension* is
// global; the inner maps are keyed by Engine via WeakMap so two engines in the
// same process keep their identity state isolated (entity IDs are not unique
// across bitECS worlds).
//
// Access goes through the `nameCacheFor` / `uidOfFor` / `parentOfFor` helpers
// below — they lazy-init the per-engine map on first use.

export const UIDComponent = defineComponent({
  id: 'UID',
  label: 'UID',
  schema: Schema.Object({
    value: Schema.String({ default: '' })
  }),
  nameCache: new WeakMap<Engine, Map<Entity, Map<string, Entity>>>(),
  uidOf: new WeakMap<Engine, Map<Entity, string>>()
})

export const BelongsTo = defineRelation({
  name: 'BelongsTo',
  exclusive: true,
  parentOf: new WeakMap<Engine, Map<Entity, Entity>>()
})

const lazy = <V>(weak: WeakMap<Engine, V>, engine: Engine, factory: () => V): V => {
  let v = weak.get(engine)
  if (!v) {
    v = factory()
    weak.set(engine, v)
  }
  return v
}

/** Get-or-create the per-engine UID → entity index, keyed by parent. */
export const nameCacheFor = (engine: Engine): Map<Entity, Map<string, Entity>> =>
  lazy(UIDComponent.nameCache, engine, () => new Map())

/** Get-or-create the per-engine entity → UID map. */
export const uidOfFor = (engine: Engine): Map<Entity, string> => lazy(UIDComponent.uidOf, engine, () => new Map())

/** Get-or-create the per-engine entity → BelongsTo parent map. */
export const parentOfFor = (engine: Engine): Map<Entity, Entity> => lazy(BelongsTo.parentOf, engine, () => new Map())

// ── Create / remove ──────────────────────────────────────────────────────────-

export const createEntity = (world: World): Entity => bitecs.addEntity(world.engine.bitECS)

export const removeEntity = (world: World, entity: Entity): void => {
  // Identity caches first (synchronous), then bitECS removal which cascades
  // component + relation cleanup and (via autoRemoveSubject) any subjects of
  // relations targeting this entity.
  cleanupIdentity(world.engine, entity)
  bitecs.removeEntity(world.engine.bitECS, entity)
}

export const entityExists = (world: World, entity: Entity): boolean => bitecs.entityExists(world.engine.bitECS, entity)

// ── Identity cache helpers (private) ─────────────────────────────────────────-

const indexInBucket = (engine: Engine, parent: Entity, uid: string, entity: Entity): void => {
  const nameCache = nameCacheFor(engine)
  let bucket = nameCache.get(parent)
  if (!bucket) {
    bucket = new Map()
    nameCache.set(parent, bucket)
  }
  const existing = bucket.get(uid)
  if (existing !== undefined && existing !== entity) {
    throw new Error(`Duplicate UID '${uid}' under parent ${parent} (existing entity ${existing})`)
  }
  bucket.set(uid, entity)
}

const unindexFromBucket = (engine: Engine, parent: Entity, uid: string): void => {
  const nameCache = nameCacheFor(engine)
  const bucket = nameCache.get(parent)
  if (!bucket) return
  bucket.delete(uid)
  if (bucket.size === 0) nameCache.delete(parent)
}

/** Clear every identity-cache entry referencing this entity. Idempotent. */
const cleanupIdentity = (engine: Engine, entity: Entity): void => {
  const uidMap = uidOfFor(engine)
  const parentMap = parentOfFor(engine)
  const nameCache = nameCacheFor(engine)
  const uid = uidMap.get(entity)
  const parent = parentMap.get(entity)
  if (uid !== undefined && parent !== undefined) {
    unindexFromBucket(engine, parent, uid)
  }
  uidMap.delete(entity)
  parentMap.delete(entity)
  // If this entity was a parent, drop its bucket too (children's BelongsTo dangles).
  nameCache.delete(entity)
}

// ── Identity API ─────────────────────────────────────────────────────────────-

export interface SetUIDOptions {
  /** Parent entity in the BelongsTo tree. Defaults to `world.worldRoot`. */
  parent?: Entity
  /** Mutation origin tag — defaults to 'local' (will replicate). Pass 'network' from the receive path. */
  origin?: Origin
}

/**
 * Assign UID + BelongsTo parent. Takes a `World` because writing the
 * `UIDComponent` + `BelongsTo` relation queues authored events on the world's
 * mutation pipeline. Default parent is `world.worldRoot` (so the entity sits
 * at the top of this world's hierarchy).
 */
export const setUID = (world: World, entity: Entity, uid: string, options: SetUIDOptions = {}): void => {
  const engine = world.engine
  const nameCache = nameCacheFor(engine)
  const uidMap = uidOfFor(engine)
  const parentMap = parentOfFor(engine)
  const parent = options.parent ?? parentMap.get(entity) ?? world.worldRoot

  // Collision check
  const existingInBucket = nameCache.get(parent)?.get(uid)
  if (existingInBucket !== undefined && existingInBucket !== entity) {
    throw new Error(`Duplicate UID '${uid}' under parent ${parent} (existing entity ${existingInBucket})`)
  }

  // Drop previous identity entries for this entity (re-parenting case)
  const previousUid = uidMap.get(entity)
  const previousParent = parentMap.get(entity) ?? world.worldRoot
  if (previousUid !== undefined) unindexFromBucket(engine, previousParent, previousUid)

  setComponent(world, entity, UIDComponent, { value: uid }, { origin: options.origin })
  uidMap.set(entity, uid)

  if (options.parent !== undefined) {
    addRelation(world, entity, BelongsTo, options.parent, { origin: options.origin })
  }
  // Always populate parentOf — default to world.worldRoot when no explicit
  // parent — so `cleanupIdentity` can find the right bucket to unindex on
  // remove. Top-level entities omit the BelongsTo edge but still live under
  // worldRoot in the identity cache.
  parentMap.set(entity, parent)

  indexInBucket(engine, parent, uid, entity)
}

/** Get UID of an entity. Falls back to reading the component if cache not populated. */
export const getUID = (world: World, entity: Entity): string | undefined =>
  uidOfFor(world.engine).get(entity) ??
  (getComponent(world, entity, UIDComponent) as { value: string } | undefined)?.value

/** Get BelongsTo parent of an entity, if any. */
export const getParent = (world: World, entity: Entity): Entity | undefined => parentOfFor(world.engine).get(entity)

/** O(1) lookup: find entity by UID under a parent. Use `world.worldRoot` for top-level. */
export const getEntityByUID = (world: World, parent: Entity, uid: string): Entity | undefined =>
  nameCacheFor(world.engine).get(parent)?.get(uid)

/** Walk BelongsTo chain root→leaf, returning the UID path. */
export const getEntityPath = (world: World, entity: Entity): string[] => {
  const uidMap = uidOfFor(world.engine)
  const parentMap = parentOfFor(world.engine)
  const path: string[] = []
  let cursor: Entity | undefined = entity
  while (cursor !== undefined) {
    const uid = uidMap.get(cursor)
    if (uid === undefined) break
    path.unshift(uid)
    cursor = parentMap.get(cursor)
  }
  return path
}

/**
 * Collect every entity descended from `root` via the BelongsTo / UID identity
 * chain (i.e. every entity that lives in `root`'s identity-cache subtree).
 * Used by `destroyWorld` to sweep a world's contents from the global caches.
 * Leaf-first ordering so callers can `removeEntity` in a safe order.
 */
export const collectDescendants = (engine: Engine, root: Entity): Entity[] => {
  const nameCache = nameCacheFor(engine)
  const out: Entity[] = []
  const stack: Entity[] = []
  const seed = nameCache.get(root)
  if (seed) for (const child of seed.values()) stack.push(child)
  while (stack.length > 0) {
    const e = stack.pop()!
    out.push(e)
    const bucket = nameCache.get(e)
    if (bucket) for (const child of bucket.values()) stack.push(child)
  }
  out.reverse()
  return out
}

/** Inverse of getEntityPath — resolve a UID path back to an entity, starting from this world's root. */
export const resolveEntityPath = (world: World, path: string[]): Entity | undefined => {
  if (path.length === 0) return undefined
  let cursor: Entity | undefined = getEntityByUID(world, world.worldRoot, path[0])
  for (let i = 1; cursor !== undefined && i < path.length; i++) {
    cursor = getEntityByUID(world, cursor, path[i])
  }
  return cursor
}
