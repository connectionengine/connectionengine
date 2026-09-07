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
 * Extension properties: `defineRelation` spreads any field on the options
 * object that is not a reserved key (`name`, `sync`, `exclusive`,
 * `autoRemoveSubject`, `store`, `onTargetRemoved`) straight onto the
 * definition, and preserves its type. Built-in relations use this to attach
 * their own indexes, such as `BelongsTo.parentOf`. User code can do the same.
 */

import * as bitecs from 'bitecs'
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
}

export interface RelationDefinition<T = void> {
  readonly name: string
  /** Whether this relation replicates. It defaults to `true` at definition time. */
  readonly sync: boolean
  readonly exclusive: boolean
  readonly autoRemoveSubject: boolean
  /** Internal bitECS relation function. Call it with a target to get a pair
   *  component. */
  readonly $relation: bitecs.Relation<T>
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
  options: O
): RelationDefinition<T> & RelationExtensions<O> => {
  const {
    name,
    sync = true,
    exclusive = false,
    autoRemoveSubject = false,
    store,
    onTargetRemoved,
    ...extensions
  } = options as RelationOptions<T> & Record<string, unknown>
  const existing = relationsByName.get(name)
  if (existing) return existing as RelationDefinition<T> & RelationExtensions<O>
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
  } as RelationDefinition<T> & RelationExtensions<O>
  relationsByRef.set($relation as bitecs.Relation<unknown>, def as RelationDefinition<unknown>)
  relationsByName.set(name, def as RelationDefinition<unknown>)
  return def
}

export const getRelationDefinition = (relation: bitecs.Relation<unknown>): RelationDefinition<unknown> | undefined =>
  relationsByRef.get(relation)

export const getRelationByName = (name: string): RelationDefinition<unknown> | undefined => relationsByName.get(name)

/** Iterate every RelationDefinition ever defined. */
export const allRelations = (): RelationDefinition<unknown>[] => Array.from(relationsByName.values())

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
