/**
 * Query — thin wrapper around bitECS query that accepts our high-level
 * Component/Relation definitions instead of raw bitECS refs.
 *
 * Re-exports the operator vocabulary (Or/And/Not/Any/All/None/Hierarchy/
 * Cascade) and modifiers (asBuffer/noCommit) verbatim — the bitECS API is
 * already the spec.
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
      // bitECS Relation called with target produces a pair component already.
      return term as bitecs.QueryTerm
    }
    if ('$relation' in term) return (term as RelationDefinition<unknown>).$relation as bitecs.QueryTerm
  }
  return term as bitecs.QueryTerm
}

export const query = (
  world: World,
  terms: QueryTerm[],
  ...modifiers: (bitecs.QueryModifier | bitecs.QueryOptions)[]
): readonly Entity[] | Readonly<Uint32Array> => bitecs.query(world, terms.map(toRef), ...modifiers)

/** Helper: relation pair builder — Relation(target). Replicates bitECS's `R(t)`. */
export const pair = <T>(relation: RelationDefinition<T>, target: Entity | typeof bitecs.Wildcard): unknown =>
  relation.$relation(target as Entity)

// Operators — wrap so they accept our high-level definitions
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
