/**
 * Query — a thin wrapper around the bitECS query. It accepts the high-level
 * Component and Relation definitions of this engine instead of raw bitECS refs.
 *
 * It re-exports the operator vocabulary (Or, And, Not, Any, All, None,
 * Hierarchy, Cascade) and the modifiers (asBuffer, noCommit) unchanged, because
 * the bitECS API is already the specification.
 */

import * as bitecs from 'bitecs'
import type { World, Entity } from '../ecs/world'
import type { ComponentDefinition } from '../ecs/component'
import type { RelationDefinition } from '../ecs/relation'

export type QueryTerm = ComponentDefinition | RelationDefinition<unknown> | bitecs.QueryTerm

const toRef = (term: unknown): bitecs.QueryTerm => {
  if (term && typeof term === 'object') {
    if ('$ref' in term) return (term as ComponentDefinition).$ref
    if ('$relation' in term && !('exclusive' in (term as object))) {
      // A bitECS Relation called with a target already produces a pair component.
      return term as bitecs.QueryTerm
    }
    if ('$relation' in term) return (term as RelationDefinition<unknown>).$relation as bitecs.QueryTerm
  }
  return term as bitecs.QueryTerm
}

/**
 * Run a bitECS query against the engine. The ECS operates engine-wide. For a
 * per-world scope, filter the result by walking the `BelongsTo` tree from
 * `world.worldRoot`. Most apps run one world per engine, and the distinction
 * disappears there.
 */
export const query = (
  world: World,
  terms: QueryTerm[],
  ...modifiers: (bitecs.QueryModifier | bitecs.QueryOptions)[]
): readonly Entity[] => bitecs.query(world.engine.bitECS, terms.map(toRef), ...modifiers) as readonly Entity[]

/** Helper that builds a relation pair, as Relation(target). It matches `R(t)` in
 *  bitECS. */
export const pair = <T>(relation: RelationDefinition<T>, target: Entity | typeof bitecs.Wildcard): unknown =>
  relation.$relation(target as Entity)

// Operators. Each wrapper accepts the high-level definitions of this engine.
export const Or = (...terms: QueryTerm[]): bitecs.OpReturnType => bitecs.Or(...terms.map(toRef))
export const And = (...terms: QueryTerm[]): bitecs.OpReturnType => bitecs.And(...terms.map(toRef))
export const Not = (...terms: QueryTerm[]): bitecs.OpReturnType => bitecs.Not(...terms.map(toRef))
export const Any = (...terms: QueryTerm[]): bitecs.OpReturnType => bitecs.Any(...terms.map(toRef))
export const All = (...terms: QueryTerm[]): bitecs.OpReturnType => bitecs.All(...terms.map(toRef))
export const None = (...terms: QueryTerm[]): bitecs.OpReturnType => bitecs.None(...terms.map(toRef))
export const Hierarchy = bitecs.Hierarchy
export const Cascade = bitecs.Cascade

// Modifiers
export const asBuffer = bitecs.asBuffer
export const noCommit = bitecs.noCommit
export const isNested = bitecs.isNested
