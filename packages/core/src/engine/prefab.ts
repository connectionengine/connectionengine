/**
 * Prefab — a named composition of ComponentDefinitions.
 *
 * The composed ComponentSchema is the union of each constituent component's
 * schema. Instantiating a prefab on a world ensures all components are
 * registered, then applies defaults + overrides per component. Optionally
 * assigns identity (parent + UID) so the entity is addressable.
 */

import type { ComponentDefinition } from '../ecs/component'
import { setComponent } from '../ecs/component'
import { createEntity } from '../ecs/entity'
import { setUID } from '../ecs/identity'
import type { Entity, World, ComponentSchema } from '../ecs/world'

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
  // Compose SHACL shape as the merge of each component's
  const composedSchema: ComponentSchema = {
    id: `prefab:${name}`,
    jsonSchema: {
      type: 'object',
      properties: Object.fromEntries(options.components.map((c) => [c.id, c.componentSchema.jsonSchema]))
    },
    shaclShape: {
      '@id': `https://connectionengine.dev/prefabs#${name}`,
      '@type': 'sh:NodeShape',
      targetClass: `prefab:${name}`,
      components: options.components.map((c) => c.componentSchema.shaclShape)
    },
    // Composed prefabs inherit the most permissive category (runtime > authored > local)
    mutationCategory: options.components.some((c) => c.mutationCategory === 'runtime')
      ? 'runtime'
      : options.components.some((c) => c.mutationCategory === 'authored')
        ? 'authored'
        : 'local'
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
    const defaults = prefab.defaults[component.id] ?? {}
    const overrides = options.overrides?.[component.id] ?? {}
    setComponent(world, entity, component, { ...defaults, ...overrides } as Record<string, unknown>)
  }
  return entity
}
