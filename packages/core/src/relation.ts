/**
 * RelationDefinition + helpers.
 *
 * Relationships are predicates — typed, queryable links between entities. They
 * replicate as authored mutations by default (discrete events) or stay local.
 *
 * Built on bitECS's createRelation; we wrap it to:
 *   - carry a stable name (predicate URI) and mutation category
 *   - thread relationship add/remove into the authored mutation queue (tier 3)
 *   - emit trace events
 *
 * Maps to canonical doc §3.7 (RelationDefinition) + §3.8 (RelationshipPair).
 */

import * as bitecs from 'bitecs'
import type { Entity, World } from './world'
import type { Origin } from './trace'

export type RelationCategory = 'authored' | 'local'

export interface RelationOptions<T = void> {
  /** Predicate name (used as the relation URI in semantic triples) */
  name: string
  /** Default 'authored' — discrete mutation, replicated. 'local' = never synced. */
  mutationCategory?: RelationCategory
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
  readonly mutationCategory: RelationCategory
  readonly exclusive: boolean
  readonly autoRemoveSubject: boolean
  /** Internal bitECS relation function — invoke with a target to get a pair component. */
  readonly $relation: bitecs.Relation<T>
}

const relationRegistry = new WeakMap<bitecs.Relation<unknown>, RelationDefinition<unknown>>()

export const defineRelation = <T = void>(options: RelationOptions<T>): RelationDefinition<T> => {
  const {
    name,
    mutationCategory = 'authored',
    exclusive = false,
    autoRemoveSubject = false,
    store,
    onTargetRemoved
  } = options
  const $relation = bitecs.createRelation<T>({
    exclusive,
    autoRemoveSubject,
    store,
    onTargetRemoved
  })
  const def: RelationDefinition<T> = {
    name,
    mutationCategory,
    exclusive,
    autoRemoveSubject,
    $relation
  }
  relationRegistry.set($relation as bitecs.Relation<unknown>, def as RelationDefinition<unknown>)
  return def
}

export const getRelationDefinition = (relation: bitecs.Relation<unknown>): RelationDefinition<unknown> | undefined =>
  relationRegistry.get(relation)

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
  bitecs.addComponent(world, subject, relation.$relation(target))
  world.trace.emit({
    kind: 'relation.add',
    ts: world.clock.now(),
    entity: subject,
    predicate: relation.name,
    origin,
    detail: { target }
  })
}

export const removeRelation = <T>(
  world: World,
  subject: Entity,
  relation: RelationDefinition<T>,
  target: Entity,
  options: RelationMutationOptions = {}
): void => {
  const origin: Origin = options.origin ?? 'local'
  bitecs.removeComponent(world, subject, relation.$relation(target))
  world.trace.emit({
    kind: 'relation.remove',
    ts: world.clock.now(),
    entity: subject,
    predicate: relation.name,
    origin,
    detail: { target }
  })
}

export const getRelationTargets = <T>(world: World, subject: Entity, relation: RelationDefinition<T>): Entity[] =>
  bitecs.getRelationTargets(world, subject, relation.$relation)

export const hasRelation = <T>(
  world: World,
  subject: Entity,
  relation: RelationDefinition<T>,
  target: Entity
): boolean => bitecs.hasComponent(world, subject, relation.$relation(target))

// ── bitECS re-exports (for advanced query composition) ────────────────────────

export const Wildcard = bitecs.Wildcard
export const IsA = bitecs.IsA
export const Pair = bitecs.Pair
