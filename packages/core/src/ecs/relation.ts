/**
 * RelationDefinition and its helpers.
 *
 * Relationships are predicates: typed, queryable links between entities. They
 * always travel as authored events, which are discrete causal mutations. A
 * relation marked `sync: false` is the one exception, and stays machine-local.
 *
 * This module builds on `createRelation` from bitECS. The wrapper adds two
 * things:
 *   - a stable name, which serves as the predicate URI
 *   - a push of each relation add and remove onto `world.authoredQueue`, which
 *     the network-layer mutation pipeline drains at the end of the tick
 *
 * Two ways to put extra state on a definition:
 *   - `index: true` on an exclusive relation. This module then keeps a
 *     subject → target map and adds `get`, `set`, and `indexFor`. `OwnedBy`,
 *     `AuthoritativeFor`, and `BelongsTo` all use it. See
 *     `RelationOptions.index`.
 *   - Any other field on the options object. `defineRelation` spreads every
 *     non-reserved key straight onto the definition, and preserves its type.
 *     The caller then maintains that state.
 */

import * as bitecs from 'bitecs'
import type { Engine } from './engine'
import type { Entity, Origin, World } from './world'

export interface RelationOptions<T = void> {
  /** Predicate name. It serves as the relation URI in semantic triples. */
  name: string
  /**
   * Whether this relation replicates as authored events. It defaults to `true`.
   * Set it to `false` to keep the relation machine-local.
   */
  sync?: boolean
  /** When true, each subject has exactly one target. A new target removes the
   *  previous one. */
  exclusive?: boolean
  /** When true, the engine destroys the subject when it destroys the target. */
  autoRemoveSubject?: boolean
  /** Factory for the per-pair data. */
  store?: () => T
  /** Hook that runs when the engine removes the target entity. */
  onTargetRemoved?: (subject: Entity, target: Entity) => void
  /**
   * Keep a per-engine subject → target index, and put `get`, `set`, and
   * `indexFor` on the definition.
   *
   * **Requires `exclusive: true`.** The index maps one subject onto one
   * target, which only a relation that holds one target per subject can
   * satisfy. `defineRelation` rejects the pairing at compile time, and throws
   * at run time for a caller that reached it without types.
   *
   * `addRelation` and `removeRelation` maintain the map, so no caller touches
   * it by hand. Omitting the option means no index. `false` would say the same
   * thing twice, so the type admits only `true`.
   *
   * The index answers one question the relation cannot: what the target *was*,
   * for a subject the engine has already removed. The bitECS cascade takes the
   * relation with the entity, so anything that has to attribute a removal reads
   * this instead. `removeEntity` captures every declared index before it
   * removes, and `cleanupIdentity` drops the entry afterwards, because entity
   * ids recycle.
   */
  index?: true
}

/**
 * What a relation gains from `index: true`.
 *
 * A relation index always maps one entity onto another, so the definition
 * carries the types rather than each declaration restating them.
 *
 * `get` and `set` are the reason the option exists. They keep the accessor on
 * the relation it reads, so `OwnedBy.get(world, entity)` needs no separate
 * `getOwner` function to find, and none to keep in step.
 */
export interface IndexedRelation {
  /** The current target of `subject`, or undefined when it has none. O(1). */
  get(world: World, subject: Entity): Entity | undefined
  /**
   * Point `subject` at `target`. The relation is exclusive, so this replaces
   * whatever it named before, and the index follows.
   */
  set(world: World, subject: Entity, target: Entity, options?: RelationMutationOptions): void
  /** The whole per-engine map. Use it to iterate. Use `get` for one subject. */
  indexFor(engine: Engine): Map<Entity, Entity>
}

/** `IndexedRelation` for a definition that declared `index: true`, and nothing
 *  for one that did not. */
export type RelationIndexAccessors<O> = O extends { index: true } ? IndexedRelation : object

/**
 * `exclusive: true` becomes mandatory once the options declare `index: true`,
 * and stays optional otherwise.
 *
 * An index holds one target for each subject. A non-exclusive relation holds
 * many, so the two together give a map that disagrees with the relation:
 *
 *   - The second `addRelation` overwrites the entry the first wrote.
 *   - Removing whichever target the entry names clears it, while the other
 *     targets still stand. The index then reports no target for a subject
 *     that has one.
 */
export type RequireExclusiveIndex<O> = O extends { index: true } ? { exclusive: true } : object

export interface RelationDefinition<T = void> {
  readonly name: string
  /** Whether this relation replicates. It defaults to `true` at definition time. */
  readonly sync: boolean
  readonly exclusive: boolean
  readonly autoRemoveSubject: boolean
  /** Internal bitECS relation function. Call it with a target to get a pair
   *  component. */
  readonly $relation: bitecs.Relation<T>
  /** Internal: per-engine subject → target index, when the definition declared
   *  `index: true`. Read it through `get` and `indexFor`. */
  readonly $index?: WeakMap<Engine, Map<Entity, Entity>>
}

/** Reserved option keys that `defineRelation` consumes itself. Every other key
 *  passed to `defineRelation` becomes a typed extension property on the
 *  resulting definition. */
type ReservedRelationOptionKey = keyof RelationOptions<unknown>

/** Fields on an options object that do *not* belong to `RelationOptions`.
 *  `defineRelation` passes these straight through onto the definition. */
export type RelationExtensions<O> = Omit<O, ReservedRelationOptionKey>

// ── Global relation registry ─────────────────────────────────────────────────-
// Relation definitions are module-level singletons, as component definitions are.
const relationsByName = new Map<string, RelationDefinition<unknown>>()
const relationsByRef = new WeakMap<bitecs.Relation<unknown>, RelationDefinition<unknown>>()

export const defineRelation = <T = void, O extends RelationOptions<T> = RelationOptions<T>>(
  options: O & RequireExclusiveIndex<O>
): RelationDefinition<T> & RelationExtensions<O> & RelationIndexAccessors<O> => {
  const {
    name,
    sync = true,
    exclusive = false,
    autoRemoveSubject = false,
    store,
    onTargetRemoved,
    index,
    ...extensions
  } = options as RelationOptions<T> & Record<string, unknown>
  if (index && !exclusive) {
    // The type constraint catches this, so reaching here means the caller came
    // from JavaScript or through a cast.
    throw new Error(
      `defineRelation('${name}'): index requires exclusive, because an index holds one target per subject`
    )
  }
  const existing = relationsByName.get(name)
  if (existing) return existing as RelationDefinition<T> & RelationExtensions<O> & RelationIndexAccessors<O>
  const $relation = bitecs.createRelation<T>({
    exclusive,
    autoRemoveSubject,
    store,
    onTargetRemoved
  })
  const def = {
    name,
    sync,
    exclusive,
    autoRemoveSubject,
    $relation,
    ...extensions
  } as RelationDefinition<T> & RelationExtensions<O> & RelationIndexAccessors<O>

  if (index) {
    const $index = new WeakMap<Engine, Map<Entity, Entity>>()
    const indexFor = (engine: Engine): Map<Entity, Entity> => {
      let map = $index.get(engine)
      if (!map) {
        map = new Map()
        $index.set(engine, map)
      }
      return map
    }
    // `set` defers to `addRelation`, which is what maintains the index. The
    // accessor stays one line, and there is still one write path.
    Object.assign(def, {
      $index,
      indexFor,
      get: (world: World, subject: Entity): Entity | undefined => indexFor(world.engine).get(subject),
      set: (world: World, subject: Entity, target: Entity, mutation?: RelationMutationOptions): void =>
        addRelation(world, subject, def as RelationDefinition<T>, target, mutation)
    } satisfies IndexedRelation & { $index: typeof $index })
  }

  relationsByRef.set($relation as bitecs.Relation<unknown>, def as RelationDefinition<unknown>)
  relationsByName.set(name, def as RelationDefinition<unknown>)
  return def
}

export const getRelationDefinition = (relation: bitecs.Relation<unknown>): RelationDefinition<unknown> | undefined =>
  relationsByRef.get(relation)

export const getRelationByName = (name: string): RelationDefinition<unknown> | undefined => relationsByName.get(name)

/** Iterate every RelationDefinition ever defined. */
export const allRelations = (): RelationDefinition<unknown>[] => Array.from(relationsByName.values())

// ── Relation indexes ─────────────────────────────────────────────────────────-

/**
 * Get-or-create the index map of a relation, for one engine, or undefined when
 * the relation declared none.
 *
 * The mutation verbs and the capture helpers work over any definition, indexed
 * or not, so they need this rather than the typed `indexFor` accessor.
 */
const indexOf = <T>(engine: Engine, relation: RelationDefinition<T>): Map<Entity, Entity> | undefined => {
  const weak = relation.$index
  if (!weak) return undefined
  let map = weak.get(engine)
  if (!map) {
    map = new Map()
    weak.set(engine, map)
  }
  return map
}

/** Every relation that declared an index. The list stays short, so the callers
 *  that walk it on entity removal walk a handful of entries. */
export const indexedRelations = (): RelationDefinition<unknown>[] =>
  Array.from(relationsByName.values()).filter((r) => r.$index !== undefined)

/**
 * The index entry of every indexed relation for one subject.
 *
 * `removeEntity` calls this before it removes, so that a later step can still
 * attribute the removal. The result names each relation by its definition, so
 * the reader stays typed: `captured.get(OwnedBy)`.
 */
export const captureRelationIndexes = (engine: Engine, subject: Entity): Map<RelationDefinition<unknown>, Entity> => {
  const captured = new Map<RelationDefinition<unknown>, Entity>()
  for (const relation of indexedRelations()) {
    const target = indexOf(engine, relation)?.get(subject)
    if (target !== undefined) captured.set(relation, target)
  }
  return captured
}

/** Drop the index entry of every indexed relation for one subject. Entity ids
 *  recycle, so a stale entry would answer for a later tenant of the same id. */
export const clearRelationIndexes = (engine: Engine, subject: Entity): void => {
  for (const relation of indexedRelations()) indexOf(engine, relation)?.delete(subject)
}

// ── add / remove pair ────────────────────────────────────────────────────────-

export interface RelationMutationOptions {
  origin?: Origin
}

export const addRelation = <T>(
  world: World,
  subject: Entity,
  relation: RelationDefinition<T>,
  target: Entity,
  options: RelationMutationOptions = {}
): void => {
  const origin: Origin = options.origin ?? 'local'
  bitecs.addComponent(world.engine.bitECS, subject, relation.$relation(target))
  // An exclusive relation replaces its previous target, so the write is enough
  // to keep the index current.
  indexOf(world.engine, relation)?.set(subject, target)
  if (origin === 'local' && relation.sync) {
    world.authoredQueue.push({
      entity: subject,
      predicate: relation.name,
      op: 'set',
      value: { target },
      origin
    })
  }
}

export const removeRelation = <T>(
  world: World,
  subject: Entity,
  relation: RelationDefinition<T>,
  target: Entity,
  options: RelationMutationOptions = {}
): void => {
  const origin: Origin = options.origin ?? 'local'
  bitecs.removeComponent(world.engine.bitECS, subject, relation.$relation(target))
  // Only when this call removed the target the index names. Removing some other
  // target of the same relation leaves the current one standing.
  const index = indexOf(world.engine, relation)
  if (index?.get(subject) === target) index.delete(subject)
  if (origin === 'local' && relation.sync) {
    world.authoredQueue.push({
      entity: subject,
      predicate: relation.name,
      op: 'remove',
      value: { target },
      origin
    })
  }
}

export const getRelationTargets = <T>(world: World, subject: Entity, relation: RelationDefinition<T>): Entity[] =>
  bitecs.getRelationTargets(world.engine.bitECS, subject, relation.$relation)

export const hasRelation = <T>(
  world: World,
  subject: Entity,
  relation: RelationDefinition<T>,
  target: Entity
): boolean => bitecs.hasComponent(world.engine.bitECS, subject, relation.$relation(target))

// ── bitECS re-exports. Use them for advanced query composition. ──────────────

export const Wildcard = bitecs.Wildcard
export const IsA = bitecs.IsA
export const Pair = bitecs.Pair
