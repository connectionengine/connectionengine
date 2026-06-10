/**
 * RelationDefinition + helpers.
 *
 * Relationships are predicates — typed, queryable links between entities.
 * They always ship as authored events (discrete causal mutations) unless
 * marked `local: true`, in which case they stay machine-local.
 *
 * Built on bitECS's createRelation; we wrap it to:
 *   - carry a stable name (predicate URI)
 *   - push relation add/remove onto `world.authoredQueue` (drained by the
 *     network-layer mutation pipeline at end of tick)
 *
 * Extension properties: any field on the `defineRelation` options object
 * that isn't a reserved key (`name`, `sync`, `exclusive`, `autoRemoveSubject`,
 * `store`, `onTargetRemoved`) is spread straight onto the definition with
 * its type preserved — used by built-in relations to attach their own
 * indexes (e.g. `BelongsTo.parentOf`) and available for user code to do the
 * same.
 */

import * as bitecs from 'bitecs'
import type { Entity, Origin, World } from './world'

export interface RelationOptions<T = void> {
  /** Predicate name (used as the relation URI in semantic triples) */
  name: string
  /**
   * Whether this relation replicates as authored events. Default `true`.
   * Set to `false` to keep the relation machine-local.
   */
  sync?: boolean
  /** If true: exactly one target per subject. Assigning new target removes old. */
  exclusive?: boolean
  /** If true: subject is destroyed when target is destroyed. */
  autoRemoveSubject?: boolean
  /** Per-pair data factory. */
  store?: () => T
  /** Hook fired when the target entity is removed. */
  onTargetRemoved?: (subject: Entity, target: Entity) => void
}

export interface RelationDefinition<T = void> {
  readonly name: string
  /** Whether this relation replicates. Defaults to `true` at definition time. */
  readonly sync: boolean
  readonly exclusive: boolean
  readonly autoRemoveSubject: boolean
  /** Internal bitECS relation function — invoke with a target to get a pair component. */
  readonly $relation: bitecs.Relation<T>
}

/** Reserved option keys consumed by `defineRelation` itself. Any other keys
 *  passed to `defineRelation` become typed extension properties on the
 *  resulting definition. */
type ReservedRelationOptionKey = keyof RelationOptions<unknown>

/** Fields on an options object that are *not* part of `RelationOptions` —
 *  these are passed straight through onto the definition. */
export type RelationExtensions<O> = Omit<O, ReservedRelationOptionKey>

// ── Global relation registry ─────────────────────────────────────────────────-
// Relation definitions are module-level singletons, same as components.
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

// ── bitECS re-exports (for advanced query composition) ────────────────────────

export const Wildcard = bitecs.Wildcard
export const IsA = bitecs.IsA
export const Pair = bitecs.Pair
