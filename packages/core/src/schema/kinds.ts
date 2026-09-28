/**
 * TypeBox Kind extensions for SoA storage.
 *
 * An SoA-tagged field goes into a shared typed array, indexed by entity ID. A
 * value-tagged field, which is a regular TypeBox primitive, goes into a
 * per-entity instance object. `defineComponent` in ../ecs/component.ts walks
 * the Kind tag AND the per-field `sync`/`sparse` options to decide where each
 * field lives and how the engine transports it.
 */

import type { TSchema } from '@sinclair/typebox'
import type { TypedArrayConstructor } from '../maths/common'

export interface ArrayBufferKind<T> extends TSchema {
  static: T
  instanceOf: TypedArrayConstructor
  sync: 'continuous' | 'discrete'
  sparse: boolean
}

export interface SoAStoreKind<T extends TypedArrayConstructor, S, C> extends TSchema {
  static: S
  instanceOf: T
  construct: new (type: T) => C
  type: 'object'
  sync: 'continuous' | 'discrete'
  sparse: boolean
}
