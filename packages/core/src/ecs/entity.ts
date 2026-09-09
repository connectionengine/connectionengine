/**
 * Entity — integer ID plus cross-world identity.
 *
 * An entity has two identifiers, and this module maintains both:
 *
 *   - **The integer ID** (`Entity = number`) is a bitECS handle. It is unique
 *     inside the bitECS world of one engine. It is runtime-local. It never goes
 *     over the wire, and it never enters user data.
 *   - **The UID path** is the stable cross-world identity of the entity. It is
 *     the list of UIDs walked from a `worldRoot` through `BelongsTo` relations.
 *     Authored events carry this path on the wire.
 *
 * Identity composes from two ECS primitives: `UIDComponent`, a string, and
 * `BelongsTo`, an exclusive relation. Each one carries its own typed extension
 * caches, which keep lookups O(1):
 *
 *   UIDComponent.nameCache : parent → (uid → entity)   for `getEntityByUID`
 *   UIDComponent.uidOf     : entity → uid              for `getUID` + path walking
 *   BelongsTo.parentOf     : child  → parent           for path walking + cache invalidation
 *
 * The caches live ON the definitions, as typed extension properties. They index
 * one component or one relation, and mean nothing apart from it, so they belong
 * there. `setUID` maintains all three. `removeEntity` clears them inline.
 *
 * For a wire-addressable entity with an owner and an authority, use
 * `spawnPrefab` from `network/prefab`. This module is the pure-ECS substrate.
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
// nameCache, uidOf, and parentOf are typed extension properties on the relevant
// definitions. They live there because they index UIDs and BelongsTo edges
// only, and no other place holds them meaningfully. Component and relation
// definitions are module-level singletons, so the *extension* is global. The
// inner maps use the Engine as their WeakMap key, so two engines in the same
// process keep their identity state isolated. Entity IDs are not unique across
// bitECS worlds.
//
// Read them through the `nameCacheFor`, `uidOfFor`, and `parentOfFor` helpers
// below. Each helper initialises the per-engine map on first use.

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

/**
 * Remove an entity from this world. Plain ECS — this function knows nothing
 * about peers.
 *
 * Removal still replicates, but reactively: the network layer observes
 * `onRemove(UIDComponent)` and queues the `destroy` when the local user owns
 * the entity. There is no networked twin of this function to remember to call.
 * See `network/mutation.ts`.
 */
export const removeEntity = (world: World, entity: Entity): void => {
  // bitECS removal first. It cascades the component and relation cleanup, and
  // through autoRemoveSubject it also removes the subjects of any relation
  // targeting this entity. Removing `UIDComponent` fires the observers, and
  // the identity caches are still intact at that moment, so an observer can
  // still read the path of the entity going away. The network layer relies on
  // that to replicate the removal.
  bitecs.removeEntity(world.engine.bitECS, entity)
  cleanupIdentity(world.engine, entity)
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
  // Drop the bucket of this entity too, if it was a parent. The BelongsTo edges
  // of its children then dangle.
  nameCache.delete(entity)
}

// ── Identity API ─────────────────────────────────────────────────────────────-

export interface SetUIDOptions {
  /** Parent entity in the BelongsTo tree. Defaults to `world.worldRoot`. */
  parent?: Entity
  /** Mutation origin tag. It defaults to 'local', which replicates. Pass
   *  'network' from the receive path. */
  origin?: Origin
}

/**
 * Assign the UID and the BelongsTo parent. This function takes a `World`,
 * because a write to the `UIDComponent` and to the `BelongsTo` relation queues
 * authored events on the mutation pipeline of that world. The parent defaults
 * to `world.worldRoot`, which puts the entity at the top of the hierarchy of
 * this world.
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

  // Drop the previous identity entries for this entity. This covers re-parenting.
  const previousUid = uidMap.get(entity)
  const previousParent = parentMap.get(entity) ?? world.worldRoot
  if (previousUid !== undefined) unindexFromBucket(engine, previousParent, previousUid)

  setComponent(world, entity, UIDComponent, { value: uid }, { origin: options.origin })
  uidMap.set(entity, uid)

  if (options.parent !== undefined) {
    addRelation(world, entity, BelongsTo, options.parent, { origin: options.origin })
  }
  // Always populate parentOf. Default it to world.worldRoot when the caller
  // gives no explicit parent, so that `cleanupIdentity` can find the correct
  // bucket to unindex on remove. A top-level entity omits the BelongsTo edge,
  // but it still lives under worldRoot in the identity cache.
  parentMap.set(entity, parent)

  indexInBucket(engine, parent, uid, entity)
}

/** Get the UID of an entity. Reads the component when the cache holds no entry. */
export const getUID = (world: World, entity: Entity): string | undefined =>
  uidOfFor(world.engine).get(entity) ??
  (getComponent(world, entity, UIDComponent) as { value: string } | undefined)?.value

/** Get the BelongsTo parent of an entity, if it has one. */
export const getParent = (world: World, entity: Entity): Entity | undefined => parentOfFor(world.engine).get(entity)

/** O(1) lookup. Find an entity by its UID under a parent. Use `world.worldRoot`
 *  for a top-level entity. */
export const getEntityByUID = (world: World, parent: Entity, uid: string): Entity | undefined =>
  nameCacheFor(world.engine).get(parent)?.get(uid)

/** Walk the BelongsTo chain from root to leaf, and return the UID path. */
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
 * Collect every entity that descends from `root` through the BelongsTo and UID
 * identity chain. That means every entity in the identity-cache subtree of
 * `root`. `destroyWorld` uses this function to sweep the contents of a world
 * from the global caches. The result is ordered leaf-first, so that a caller
 * can call `removeEntity` in a safe order.
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

/** The inverse of getEntityPath. Resolve a UID path back to an entity, and
 *  start from the root of this world. */
export const resolveEntityPath = (world: World, path: string[]): Entity | undefined => {
  if (path.length === 0) return undefined
  let cursor: Entity | undefined = getEntityByUID(world, world.worldRoot, path[0])
  for (let i = 1; cursor !== undefined && i < path.length; i++) {
    cursor = getEntityByUID(world, cursor, path[i])
  }
  return cursor
}
