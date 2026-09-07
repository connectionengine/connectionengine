/**
 * Prefab + spawn — the networked-entity factory.
 *
 * One concept, one function. Every wire-addressable entity is spawned via
 * `spawnPrefab` — with an optional prefab parameter that bundles a set of
 * components to apply at creation. The factory composes the four primitives
 * every networked entity needs:
 *
 *   1. `createEntity`               — allocate the bitECS entity
 *   2. `setUID(uid, { parent })`    — wire-addressable path
 *   3. `OwnedBy(owner)`             — permanent provenance (defaults to localUser)
 *   4. `AuthoritativeFor(authority)`— runtime authority (defaults to localPeer)
 *
 * Plus, when a prefab is given, applies its component bundle (defaults merged
 * under per-instance overrides).
 *
 * For pure-ECS scaffolding (test entities, system caches, derived state that
 * doesn't replicate) use `createEntity` from `ecs/entity` directly. `spawnPrefab`
 * is for first-class networked things.
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
  /** Composed ComponentSchema — union of constituent schemas. */
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

// ── spawnPrefab — the networked-entity factory ───────────────────────────────-

export interface SpawnPrefabOptions {
  /** Apply this prefab's components to the spawned entity. */
  prefab?: PrefabDefinition
  /** Parent entity. Defaults to `world.worldRoot` (top-level). */
  parent?: Entity
  /** Owner user entity. Defaults to `world.localUser`. */
  owner?: Entity
  /** Authority peer entity. Defaults to `world.localPeer`. */
  authority?: Entity
  /** Per-component initial values, merged over prefab defaults. Ignored when no prefab. */
  overrides?: Partial<Record<string, Record<string, unknown>>>
}

/**
 * Spawn a networked entity. Pass `{ prefab }` in options to also apply a
 * prefab's component bundle. Throws if no owner can be determined — every
 * networked entity must have an owner from creation.
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
