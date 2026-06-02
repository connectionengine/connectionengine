/**
 * Entity — integer ID.
 *
 * Has no data of its own; all state lives in components and relationships.
 * Entity IDs are runtime-local — never sent over the network. Identity for
 * networking is the BelongsTo+UID path (see identity.ts).
 */

import * as bitecs from 'bitecs'
import type { World, Entity } from './world'

export type { Entity } from './world'

export interface CreateEntityOptions {
  /** Skip trace emission — used by internal cascading removes to avoid double-events. */
  silent?: boolean
}

export const createEntity = (world: World, options: CreateEntityOptions = {}): Entity => {
  const entity = bitecs.addEntity(world)
  if (!options.silent) {
    world.trace.emit({ kind: 'entity.create', ts: world.clock.now(), entity })
  }
  return entity
}

export const removeEntity = (world: World, entity: Entity, options: CreateEntityOptions = {}): void => {
  // Components clean themselves up: bitECS removes all components on entity removal,
  // and our component observer registry (see component.ts) cascades stores + caches.
  bitecs.removeEntity(world, entity)
  // Identity bookkeeping is handled by component observers (identity.ts) — they
  // see the UID/BelongsTo removal and update caches accordingly.
  if (!options.silent) {
    world.trace.emit({ kind: 'entity.remove', ts: world.clock.now(), entity })
  }
}

export const entityExists = (world: World, entity: Entity): boolean => bitecs.entityExists(world, entity)
