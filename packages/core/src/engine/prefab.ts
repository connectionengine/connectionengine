/**
 * Prefab — a named composition of ComponentDefinitions.
 *
 * The composed ComponentSchema is the union of each constituent component's
 * schema. Instantiating a prefab on a world ensures all components are
 * registered, then applies defaults + overrides per component. Optionally
 * assigns identity (parent + UID) so the entity is addressable.
 */

import type { ComponentDefinition, ComponentSchema } from '../ecs/component'
import { setComponent } from '../ecs/component'
import { createEntity } from '../ecs/entity'
import { setUID } from '../ecs/identity'
import type { Entity, World } from '../ecs/world'

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
  // A prefab is a composition — its constituent components each carry their
  // own channel. We surface the broadest channel for SHACL metadata only:
  // continuous > event > local.
  const channels = new Set(options.components.map((c) => c.$channel))
  const channel: ComponentSchema['channel'] = channels.has('continuous')
    ? 'continuous'
    : channels.has('event')
      ? 'event'
      : 'local'
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
    },
    channel
  }
  return {
    name,
    components: options.components,
    composedSchema,
    defaults: Object.freeze(options.defaults ?? {})
  }
}

export interface InstantiateOptions {
  parent?: Entity
  uid?: string
  /** Per-component initial values, merged over prefab defaults. */
  overrides?: Partial<Record<string, Record<string, unknown>>>
}

export const instantiatePrefab = (world: World, prefab: PrefabDefinition, options: InstantiateOptions = {}): Entity => {
  const entity = createEntity(world)
  if (options.uid !== undefined) setUID(world, entity, options.uid, { parent: options.parent })
  for (const component of prefab.components) {
    const defaults = prefab.defaults[component.$id] ?? {}
    const overrides = options.overrides?.[component.$id] ?? {}
    setComponent(world, entity, component, { ...defaults, ...overrides } as Record<string, unknown>)
  }
  return entity
}
