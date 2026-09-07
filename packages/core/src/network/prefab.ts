/**
 * Prefab and spawn — the factory for a networked entity.
 *
 * One concept, one function. `spawnPrefab` spawns every wire-addressable
 * entity. Its optional prefab parameter bundles a set of components to apply at
 * creation. The factory composes the four primitives that every networked
 * entity needs:
 *
 *   1. `createEntity`               — allocate the bitECS entity
 *   2. `setUID(uid, { parent })`    — give it a wire-addressable path
 *   3. `OwnedBy(owner)`             — permanent provenance, default localUser
 *   4. `AuthoritativeFor(authority)`— runtime authority, default localPeer
 *
 * When the caller supplies a prefab, the factory also applies the component
 * bundle of that prefab. It merges the prefab defaults under the per-instance
 * overrides.
 *
 * For pure-ECS scaffolding, use `createEntity` from `ecs/entity` directly. That
 * covers test entities, system caches, and derived state that never replicates.
 * Use `spawnPrefab` for anything that has to reach another peer.
 */

import type { ComponentDefinition, ComponentSchema } from '../ecs/component'
import { setComponent } from '../ecs/component'
import { createEntity, setUID } from '../ecs/entity'
import { addRelation } from '../ecs/relation'
import type { Entity, World } from '../ecs/world'
import { AuthoritativeFor, OwnedBy } from './authority'

// ── Prefab definition ────────────────────────────────────────────────────────-

export interface PrefabDefinition {
  readonly name: string
  readonly components: ReadonlyArray<ComponentDefinition>
  /** The composed ComponentSchema. It unions the constituent schemas. */
  readonly composedSchema: ComponentSchema
  readonly defaults: Readonly<Partial<Record<string, Record<string, unknown>>>>
}

export interface DefinePrefabOptions {
  components: ComponentDefinition[]
  defaults?: Partial<Record<string, Record<string, unknown>>>
}

export const definePrefab = (name: string, options: DefinePrefabOptions): PrefabDefinition => {
  const composedSchema: ComponentSchema = {
    id: `prefab:${name}`,
    jsonSchema: {
      type: 'object',
      properties: Object.fromEntries(options.components.map((c) => [c.$id, c.$componentSchema.jsonSchema]))
    },
    shaclShape: {
      '@id': `https://connectionengine.dev/prefabs#${name}`,
      '@type': 'sh:NodeShape',
      targetClass: `prefab:${name}`,
      components: options.components.map((c) => c.$componentSchema.shaclShape)
    }
  }
  return {
    name,
    components: options.components,
    composedSchema,
    defaults: Object.freeze(options.defaults ?? {})
  }
}

// ── spawnPrefab — the factory for a networked entity ─────────────────────────-

export interface SpawnPrefabOptions {
  /** Apply the components of this prefab to the spawned entity. */
  prefab?: PrefabDefinition
  /** Parent entity. It defaults to `world.worldRoot`, which is top level. */
  parent?: Entity
  /** Owner user entity. It defaults to `world.localUser`. */
  owner?: Entity
  /** Authority peer entity. It defaults to `world.localPeer`. */
  authority?: Entity
  /** Per-component initial values. The factory merges them over the prefab
   *  defaults, and ignores them when the caller supplies no prefab. */
  overrides?: Partial<Record<string, Record<string, unknown>>>
}

/**
 * Spawn a networked entity. Pass `{ prefab }` in the options to apply the
 * component bundle of a prefab as well. The function throws when it can
 * determine no owner, because every networked entity must hold an owner from
 * creation.
 *
 * @example
 *   spawnPrefab(world, 'scene:main')                         // bare scene root
 *   spawnPrefab(world, 'avatar:alice', { prefab: Avatar })   // with components
 *   spawnPrefab(world, 'item:1', { parent: scene, prefab: Sword, overrides: { 'Damage': { amount: 50 } } })
 */
export const spawnPrefab = (world: World, uid: string, options: SpawnPrefabOptions = {}): Entity => {
  const owner = options.owner ?? world.localUser
  if (owner === undefined) {
    throw new Error(
      `spawnPrefab('${uid}'): no owner provided and world.localUser is unset. ` +
        `Call createUser({ asLocal: true }) first, or pass an explicit \`owner\`.`
    )
  }
  const entity = createEntity(world)
  if (options.parent !== undefined) setUID(world, entity, uid, { parent: options.parent })
  else setUID(world, entity, uid)
  addRelation(world, entity, OwnedBy, owner)
  const authority = options.authority ?? world.localPeer
  if (authority !== undefined) addRelation(world, entity, AuthoritativeFor, authority)
  if (options.prefab) {
    for (const component of options.prefab.components) {
      const defaults = options.prefab.defaults[component.$id] ?? {}
      const overrides = options.overrides?.[component.$id] ?? {}
      setComponent(world, entity, component, { ...defaults, ...overrides } as Record<string, unknown>)
    }
  }
  return entity
}
