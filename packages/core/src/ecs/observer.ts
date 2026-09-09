/**
 * Observer API — a thin wrapper around the bitECS `observe` function and its
 * hook constructors.
 *
 * It exposes onAdd, onRemove, onSet, and onGet, plus the boolean operators Or,
 * And, Not, Any, All, and None. It re-exports the bitECS API unchanged.
 *
 * Observers differ from reactors. An observer is an immediate synchronous hook
 * for a lightweight side effect, such as cache maintenance or constraint
 * enforcement. A reactor is a reactive logic tree that Solid mounts. See
 * system.ts.
 */

import * as bitecs from 'bitecs'
import type { World, Entity } from './world'
import type { ComponentDefinition } from './component'
import type { RelationDefinition } from './relation'

export type ObserverTerm = ComponentDefinition | RelationDefinition<unknown> | bitecs.OpReturnType | bitecs.ComponentRef

/** Convert a high-level definition into the bitECS ref that it wraps. */
const toRef = (term: unknown): bitecs.ComponentRef => {
  if (term && typeof term === 'object') {
    if ('$ref' in term) return (term as ComponentDefinition).$ref
    if ('$relation' in term) return (term as RelationDefinition<unknown>).$relation as bitecs.ComponentRef
  }
  return term as bitecs.ComponentRef
}

const toBitecsTerms = (terms: unknown[]): bitecs.QueryTerm[] => terms.map(toRef)

export const onAdd = (...terms: ObserverTerm[]): bitecs.ObservableHook => bitecs.onAdd(...toBitecsTerms(terms))

export const onRemove = (...terms: ObserverTerm[]): bitecs.ObservableHook => bitecs.onRemove(...toBitecsTerms(terms))

export const onSet = (component: ComponentDefinition): bitecs.ObservableHook => bitecs.onSet(toRef(component))

export const onGet = (component: ComponentDefinition): bitecs.ObservableHook => bitecs.onGet(toRef(component))

export const Or = (...terms: ObserverTerm[]): bitecs.OpReturnType => bitecs.Or(...toBitecsTerms(terms))

export const And = (...terms: ObserverTerm[]): bitecs.OpReturnType => bitecs.And(...toBitecsTerms(terms))

export const Not = (...terms: ObserverTerm[]): bitecs.OpReturnType => bitecs.Not(...toBitecsTerms(terms))

export const Any = (...terms: ObserverTerm[]): bitecs.OpReturnType => bitecs.Any(...toBitecsTerms(terms))

export const All = (...terms: ObserverTerm[]): bitecs.OpReturnType => bitecs.All(...toBitecsTerms(terms))

export const None = (...terms: ObserverTerm[]): bitecs.OpReturnType => bitecs.None(...toBitecsTerms(terms))

export const observe = (
  world: World,
  hook: bitecs.ObservableHook,
  callback: (entity: Entity, ...args: unknown[]) => unknown
): (() => void) => bitecs.observe(world.engine.bitECS, hook, callback as (eid: number, ...args: unknown[]) => unknown)
