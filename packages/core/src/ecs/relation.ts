/**
 * RelationDefinition + helpers.
 *
 * Relationships are predicates — typed, queryable links between entities.
 * They always ship as authored events (discrete causal mutations) unless
 * marked `local: true`, in which case they stay machine-local.
 *
 * Built on bitECS's createRelation; we wrap it to:
 *   - carry a stable name (predicate URI)
 *   - thread relation add/remove into the authored mutation queue (engine layer)
 *   - emit trace events
 */

import * as bitecs from 'bitecs'
import type { Entity, World } from './world'
import type { Engine } from './engine'
import { getDefaultEngine } from './engine'
import type { Origin } from './trace'

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
  /** Engine to register against. Defaults to the ambient engine. */
  engine?: Engine
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

export const defineRelation = <T = void>(options: RelationOptions<T>): RelationDefinition<T> => {
  const engine = options.engine ?? getDefaultEngine()
  const { name, sync = true, exclusive = false, autoRemoveSubject = false, store, onTargetRemoved } = options
  const existing = engine.relations.get(name)
  if (existing) return existing as RelationDefinition<T>
  const $relation = bitecs.createRelation<T>({
    exclusive,
    autoRemoveSubject,
    store,
    onTargetRemoved
  })
  const def: RelationDefinition<T> = {
    name,
    sync,
    exclusive,
    autoRemoveSubject,
    $relation
  }
  engine.relationsByRef.set($relation as bitecs.Relation<unknown>, def as RelationDefinition<unknown>)
  engine.relations.set(name, def as RelationDefinition<unknown>)
  return def
}

export const getRelationDefinition = (
  worldOrEngine: World | Engine,
  relation: bitecs.Relation<unknown>
): RelationDefinition<unknown> | undefined => {
  const engine = 'bitECS' in worldOrEngine ? worldOrEngine : worldOrEngine.engine
  return engine.relationsByRef.get(relation)
}

export const getRelationByName = (name: string, engine?: Engine): RelationDefinition<unknown> | undefined =>
  (engine ?? getDefaultEngine()).relations.get(name)

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
