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
 * `BelongsTo`, an exclusive relation. Each one carries its own index, which
 * keeps lookups O(1):
 *
 *   UIDComponent.nameCache : parent → (uid → entity)   for `getEntityByUID`
 *   UIDComponent.uidOf     : entity → uid              for `UIDComponent.get` + path walking
 *   BelongsTo (index: true): child  → parent           for `BelongsTo.get` + cache invalidation
 *
 * Each index lives ON the definition it describes, and means nothing apart from
 * it. `BelongsTo` declares `index: true` and `defineRelation` supplies the
 * accessors. The two UID indexes are shaped differently, so they stay typed
 * extension properties. `setUID` maintains all three. `removeEntity` clears
 * them inline.
 *
 * For a wire-addressable entity with an owner and an authority, use
 * `spawnPrefab` from `network/prefab`. This module is the pure-ECS substrate.
 */

import * as bitecs from 'bitecs'
import { Schema } from '../schema'
import { defineComponent, getComponent, setComponent } from './component'
import { captureRelationIndexes, clearRelationIndexes, defineRelation } from './relation'
import type { Engine } from './engine'
import type { Entity, Origin, World } from './world'

export type { Entity } from './world'

// ── Built-in identity component + relation ───────────────────────────────────-
//
// The identity indexes hang off the definitions they describe. A definition is
// a module-level singleton, so the *extension* is global. Each inner map uses
// the Engine as its WeakMap key, so two engines in one process keep their
// identity state apart. Entity ids are not unique across bitECS worlds.
//
// `BelongsTo` declares `index: true`, so `defineRelation` gives it `get`, `set`
// and `indexFor`. The two UID indexes are shaped differently — one maps an
// entity to a string, the other nests two levels — so they stay as typed
// extension properties on the definition, read through `UIDComponent.get` for
// one entity, or `uidOfFor` and `nameCacheFor` for the whole map.
//
// `UIDComponent.get` and the accessors below name each other. Only their bodies
// do, and a body runs long after this module evaluates, so the cycle resolves
// itself. Ordinary `const` rules still apply: calling any of them at module
// scope, above its declaration, throws a ReferenceError on import.

const lazy = <V>(weak: WeakMap<Engine, V>, engine: Engine, factory: () => V): V => {
  let v = weak.get(engine)
  if (!v) {
    v = factory()
    weak.set(engine, v)
  }
  return v
}

export const UIDComponent = defineComponent({
  id: 'UID',
  label: 'UID',
  schema: Schema.Object({
    value: Schema.String({ default: '' })
  }),
  nameCache: new WeakMap<Engine, Map<Entity, Map<string, Entity>>>(),
  uidOf: new WeakMap<Engine, Map<Entity, string>>(),
  /**
   * The UID of an entity, from the index. It falls back to component storage,
   * so an entity whose UID arrived by a route that skipped `setUID` still
   * answers.
   *
   * The body names `uidOfFor` and `readUIDValue`, both declared below. A body
   * runs after this module finishes evaluating, so the forward reference
   * resolves.
   */
  get: (world: World, entity: Entity): string | undefined =>
    uidOfFor(world.engine).get(entity) ?? readUIDValue(world, entity)
})

/** Get-or-create the per-engine UID → entity index, keyed by parent. */
export const nameCacheFor = (engine: Engine): Map<Entity, Map<string, Entity>> =>
  lazy(UIDComponent.nameCache, engine, () => new Map())

/** Get-or-create the per-engine entity → UID map. Use it to iterate every named
 *  entity. Use `UIDComponent.get` for one. */
export const uidOfFor = (engine: Engine): Map<Entity, string> => lazy(UIDComponent.uidOf, engine, () => new Map())

/**
 * The UID held in component storage.
 *
 * It sits outside the definition so that `getComponent` sees a fully resolved
 * `UIDComponent` and returns `{ value: string } | undefined`. Inlining this
 * into the initialiser above compiles, but the self-reference degrades to
 * `unknown` there and needs a cast to read `.value` — which would then hide a
 * genuine mismatch if the schema ever changed.
 */
const readUIDValue = (world: World, entity: Entity): string | undefined =>
  getComponent(world, entity, UIDComponent)?.value

export const BelongsTo = defineRelation({
  name: 'BelongsTo',
  exclusive: true,
  index: true
})

// ── Create / remove ──────────────────────────────────────────────────────────-

export const createEntity = (world: World): Entity => bitecs.addEntity(world.engine.bitECS)

/**
 * Remove an entity from this world, and queue the removal for replication.
 *
 * This function pairs with `setUID`, the same way `removeComponent` pairs with
 * `setComponent` and `removeRelation` pairs with `addRelation`. Every mutation
 * verb authors its own reverse inline, at the point of the mutation. Do not
 * recover this event from an observer instead: `observe` registers per engine,
 * so the callback would run once for each world that shares one.
 *
 * Queueing is not sending. `flushAuthored` decides what travels, and it drops
 * a destroy this peer does not own. Ownership does two jobs there: it stops a
 * peer announcing the removal of something it does not own, and it suppresses
 * the echo, because a received destroy names an entity owned by the *remote*
 * user.
 *
 * An anonymous entity queues nothing. The wire addresses entities by path, so
 * one without a path cannot be named.
 *
 * The queued event also carries the index entries of the departing entity, so
 * that a later step can still attribute the removal. `network/mutation.ts`
 * reads the `OwnedBy` entry to gate what travels. Nothing here names ownership.
 *
 * `DESTROY_PREDICATE` names the predicate the queued event carries. The apply
 * path branches on `op` before it resolves a predicate, so it never names a
 * component or a relation, and the `@` prefix keeps it clear of user
 * predicates. It lives here because this function is the only thing that
 * produces it.
 */
export const DESTROY_PREDICATE = '@destroy'

export const removeEntity = (world: World, entity: Entity): void => {
  // Capture before the removal. The bitECS cascade takes the relations, and
  // `cleanupIdentity` takes the path, so neither survives to flush time. The
  // capture stays generic: this function collects whatever indexes the defined
  // relations declare, and names none of them.
  const entityPath = getEntityPath(world, entity)
  if (entityPath.length > 0) {
    world.authoredQueue.push({
      entity,
      predicate: DESTROY_PREDICATE,
      op: 'destroy',
      value: null,
      origin: 'local',
      entityPath,
      indexed: captureRelationIndexes(world.engine, entity)
    })
  }
  // bitECS removal cascades the component and relation cleanup, and through
  // autoRemoveSubject it also removes the subjects of any relation targeting
  // this entity.
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
  const parentMap = BelongsTo.indexFor(engine)
  const nameCache = nameCacheFor(engine)
  const uid = uidMap.get(entity)
  const parent = parentMap.get(entity)
  if (uid !== undefined && parent !== undefined) {
    unindexFromBucket(engine, parent, uid)
  }
  uidMap.delete(entity)
  // `clearRelationIndexes` covers BelongsTo along with every other indexed
  // relation, so the parent entry needs no separate delete.
  clearRelationIndexes(engine, entity)
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
  const parentMap = BelongsTo.indexFor(engine)
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
    BelongsTo.set(world, entity, options.parent, { origin: options.origin })
  }
  // Then write the index directly, which is the one place that does. A
  // top-level entity carries no BelongsTo edge — nothing replicates, because
  // `worldRoot` is local to each peer — yet it still sits under `worldRoot` in
  // the identity cache, so that `cleanupIdentity` finds the right bucket on
  // remove. `BelongsTo.get` therefore answers for every named entity, whether
  // or not an edge exists.
  parentMap.set(entity, parent)

  indexInBucket(engine, parent, uid, entity)
}

/** O(1) lookup. Find an entity by its UID under a parent. Use `world.worldRoot`
 *  for a top-level entity. */
export const getEntityByUID = (world: World, parent: Entity, uid: string): Entity | undefined =>
  nameCacheFor(world.engine).get(parent)?.get(uid)

/** Walk the BelongsTo chain from root to leaf, and return the UID path. */
export const getEntityPath = (world: World, entity: Entity): string[] => {
  const uidMap = uidOfFor(world.engine)
  const parentMap = BelongsTo.indexFor(world.engine)
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
