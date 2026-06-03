/**
 * Entity — integer ID.
 *
 * Has no data of its own; all state lives in components and relationships.
 * Entity IDs are runtime-local (allocated from the engine's shared bitECS
 * world) — never sent over the network. Identity for networking is the
 * BelongsTo+UID path (see identity.ts).
 *
 * `createEntity(world)` allocates from `world.engine.bitECS` and tracks the
 * entity in `world.entities` so per-world queries and cleanup stay scoped.
 */

import * as bitecs from 'bitecs'
import type { World, Entity } from './world'

export type { Entity } from './world'

export interface CreateEntityOptions {
  /** Skip trace emission — used by internal cascading removes to avoid double-events. */
  silent?: boolean
}

export const createEntity = (world: World, options: CreateEntityOptions = {}): Entity => {
  const entity = bitecs.addEntity(world.engine.bitECS)
  world.entities.add(entity)
  if (!options.silent) {
    world.trace.emit({ kind: 'entity.create', ts: world.clock.now(), entity })
  }
  return entity
}

export const removeEntity = (world: World, entity: Entity, options: CreateEntityOptions = {}): void => {
  // Identity caches first (synchronous), then bitECS removal which cascades
  // component + relation cleanup and (via autoRemoveSubject) any subjects of
  // relations targeting this entity.
  for (const hook of removeHooks) hook(world, entity)
  bitecs.removeEntity(world.engine.bitECS, entity)
  world.entities.delete(entity)
  if (!options.silent) {
    world.trace.emit({ kind: 'entity.remove', ts: world.clock.now(), entity })
  }
}

/**
 * Pre-removal hook registry. Modules (identity, mutation pipeline) register
 * cleanup functions here at module load to avoid import cycles.
 */
const removeHooks: Array<(world: World, entity: Entity) => void> = []
export const registerRemoveHook = (hook: (world: World, entity: Entity) => void): void => {
  removeHooks.push(hook)
}

export const entityExists = (world: World, entity: Entity): boolean => bitecs.entityExists(world.engine.bitECS, entity)
