/**
 * TypeBox Kind extensions for SoA storage.
 *
 * SoA-tagged fields go into shared typed arrays indexed by entity ID.
 * Value-tagged fields (regular TypeBox primitives) go into per-entity instance
 * objects. The Kind tag is what defineComponent (../component.ts) walks to
 * decide where each field lives and how it's transported.
 */

import type { TSchema } from '@sinclair/typebox'
import type { TypedArrayConstructor } from '../maths/common'

export interface ArrayBufferKind<T> extends TSchema {
  static: T
  instanceOf: TypedArrayConstructor
}

export interface SoAStoreKind<T extends TypedArrayConstructor, S, C> extends TSchema {
  static: S
  instanceOf: T
  construct: new (type: T) => C
  type: 'object'
}
