/**
 * Observer API — thin wrapper around bitECS observe + hook constructors.
 *
 * Exposes onAdd / onRemove / onSet / onGet plus the boolean operators
 * (Or / And / Not / Any / All / None). Re-exports the bitECS API verbatim.
 *
 * Observers vs reactors: observers are immediate synchronous hooks for
 * lightweight side effects (cache maintenance, constraint enforcement).
 * Reactors are reactive logic trees mounted via Solid (see system.ts).
 */

import * as bitecs from 'bitecs'
import type { World, Entity } from './world'
import type { ComponentDefinition } from './component'
import type { RelationDefinition } from './relation'

export type ObserverTerm = ComponentDefinition | RelationDefinition<unknown> | bitecs.OpReturnType | bitecs.ComponentRef

/** Convert our high-level definitions into the bitECS refs they wrap. */
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
): (() => void) => bitecs.observe(world, hook, callback as (eid: number, ...args: unknown[]) => unknown)
