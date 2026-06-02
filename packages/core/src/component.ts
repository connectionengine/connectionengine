/**
 * ComponentDefinition — schema-driven, mutation-categorised, SHACL-shape-bearing.
 *
 * One `defineComponent({ id, label, schema, mutationCategory? })` produces:
 *   - SoA stores (typed arrays) for SoA-tagged fields (Vec3, Quat, Float32, ...)
 *   - per-entity instance store for value-typed fields (string, boolean, ...)
 *   - a ComponentSchema (jsonSchema + shaclShape + mutationCategory) registered
 *     with the world's schema map for replication metadata
 *   - mutation category derived from schema field types if not specified:
 *       any SoA field → 'runtime', else → 'authored'
 *
 * setComponent / getComponent / removeComponent operate against bitECS storage
 * + our instance store, fire observers, and feed the mutation pipeline.
 *
 * Maps to canonical doc §3.4 (ComponentDefinition) + §3.5 (ComponentInstance).
 */

import * as bitecs from 'bitecs'
import { Kind, type Static, type TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { resizableArray } from './maths/common'
import type { ArrayBufferKind, SoAStoreKind } from './schema/kinds'
import type { World, Entity, ComponentSchema } from './world'
import type { Origin } from './trace'

// ── Types ─────────────────────────────────────────────────────────────────────

export type MutationCategory = 'authored' | 'runtime' | 'local'

export interface ComponentOptions<T extends TSchema = TSchema> {
  id: string
  label?: string
  schema: T
  mutationCategory?: MutationCategory
}

export interface ComponentDefinition<T extends TSchema = TSchema> {
  readonly id: string
  readonly label: string
  readonly $schema: T
  readonly mutationCategory: MutationCategory
  readonly componentSchema: ComponentSchema
  /** SoA stores keyed by field name. Each value is a typed array or SoA helper instance. */
  readonly $soa: Record<string, unknown>
  /** Per-entity instance store for value-typed fields. */
  readonly $store: Record<Entity, Record<string, unknown>>
  /** Default values per field, applied on first set. */
  readonly $defaults: Record<string, unknown>
  /** Internal: bitECS component ref for query/has/add. */
  readonly $ref: bitecs.ComponentRef
  /** Internal: field names tagged as SoA — used by mutation pipeline + serializer. */
  readonly $soaFields: readonly string[]
  /** Internal: value-typed (instance store) field names. */
  readonly $valueFields: readonly string[]
}

// ── Schema walking ────────────────────────────────────────────────────────────

interface FieldClassification {
  soaFields: string[]
  valueFields: string[]
}

const classifyFields = (schema: TSchema): FieldClassification => {
  const soaFields: string[] = []
  const valueFields: string[] = []
  if (schema.type !== 'object' || !schema.properties) return { soaFields, valueFields }
  for (const key of Object.keys(schema.properties)) {
    const prop = (schema.properties as Record<string, TSchema>)[key]
    const kind = prop[Kind]
    if (kind === 'ArrayBuffer' || kind === 'SoAStore') soaFields.push(key)
    else valueFields.push(key)
  }
  return { soaFields, valueFields }
}

const buildSoAStores = (schema: TSchema): Record<string, unknown> => {
  const stores: Record<string, unknown> = {}
  if (schema.type !== 'object' || !schema.properties) return stores
  for (const key of Object.keys(schema.properties)) {
    const prop = (schema.properties as Record<string, TSchema>)[key]
    const kind = prop[Kind]
    if (kind === 'ArrayBuffer') {
      const arrayKind = prop as unknown as ArrayBufferKind<unknown>
      stores[key] = resizableArray(arrayKind.instanceOf)
    } else if (kind === 'SoAStore') {
      const storeKind = prop as unknown as SoAStoreKind<never, unknown, unknown>
      stores[key] = new storeKind.construct(storeKind.instanceOf)
    }
  }
  return stores
}

const buildDefaults = (schema: TSchema): Record<string, unknown> => {
  const defaults: Record<string, unknown> = {}
  if (schema.type !== 'object' || !schema.properties) return defaults
  for (const [key, prop] of Object.entries(schema.properties as Record<string, TSchema>)) {
    if ('default' in prop) defaults[key] = prop.default
  }
  return defaults
}

// ── ComponentSchema (SHACL stub) ──────────────────────────────────────────────

const SHACL_NS = 'https://connectionengine.dev/shacl#'

const toShaclShape = (id: string, schema: TSchema, mutationCategory: MutationCategory): object => {
  // Minimal SHACL shape — id maps to a NodeShape URI, fields become PropertyShapes.
  // This is the metadata other peers receive to interpret incoming triples; a full
  // SHACL engine isn't needed at runtime, validation is handled by governance + TypeBox.
  const properties: object[] = []
  if (schema.type === 'object' && schema.properties) {
    for (const [name, prop] of Object.entries(schema.properties as Record<string, TSchema>)) {
      const kind = prop[Kind]
      properties.push({
        '@id': `${SHACL_NS}${id}/${name}`,
        path: name,
        datatype: kind ?? prop.type ?? 'unknown',
        soa: kind === 'ArrayBuffer' || kind === 'SoAStore'
      })
    }
  }
  return {
    '@id': `${SHACL_NS}${id}`,
    '@type': 'sh:NodeShape',
    targetClass: id,
    mutationCategory,
    properties
  }
}

// ── deriveMutationCategory ────────────────────────────────────────────────────

export const deriveMutationCategory = (schema: TSchema): MutationCategory => {
  const { soaFields } = classifyFields(schema)
  return soaFields.length > 0 ? 'runtime' : 'authored'
}

// ── defineComponent ───────────────────────────────────────────────────────────

const componentRegistry = new WeakMap<bitecs.ComponentRef, ComponentDefinition>()

export const defineComponent = <T extends TSchema>(options: ComponentOptions<T>): ComponentDefinition<T> => {
  const { id, label = id, schema } = options
  const mutationCategory = options.mutationCategory ?? deriveMutationCategory(schema)
  const { soaFields, valueFields } = classifyFields(schema)
  const $soa = buildSoAStores(schema)
  const $defaults = buildDefaults(schema)

  // bitECS component ref — we use $soa as the data ref so query() filters work
  // identically whether or not the component carries SoA fields. For pure-value
  // components, an empty object is fine.
  const $ref: bitecs.ComponentRef = $soa as bitecs.ComponentRef

  const componentSchema: ComponentSchema = {
    id,
    jsonSchema: schema as object,
    shaclShape: toShaclShape(id, schema, mutationCategory),
    mutationCategory
  }

  const definition: ComponentDefinition<T> = {
    id,
    label,
    $schema: schema,
    mutationCategory,
    componentSchema,
    $soa,
    $store: {},
    $defaults,
    $ref,
    $soaFields: soaFields,
    $valueFields: valueFields
  }
  componentRegistry.set($ref, definition as ComponentDefinition)
  return definition
}

/** Resolve a ComponentDefinition from its bitECS ref. */
export const getComponentDefinition = (ref: bitecs.ComponentRef): ComponentDefinition | undefined =>
  componentRegistry.get(ref)

// ── Registration on a world ───────────────────────────────────────────────────

const registeredWorldComponents = new WeakMap<World, Set<ComponentDefinition>>()

const ensureRegistered = (world: World, component: ComponentDefinition): void => {
  let set = registeredWorldComponents.get(world)
  if (!set) {
    set = new Set()
    registeredWorldComponents.set(world, set)
  }
  if (set.has(component)) return
  set.add(component)
  world.network.schemas.set(component.id, component.componentSchema)
}

// ── set / get / remove ────────────────────────────────────────────────────────

export interface SetComponentOptions {
  /** Origin tag for the mutation pipeline. 'local' (default) is outbound; 'network' is suppressed. */
  origin?: Origin
}

const writeSoA = (component: ComponentDefinition, entity: Entity, value: Record<string, unknown>): void => {
  for (const field of component.$soaFields) {
    if (!(field in value)) continue
    const v = (value as Record<string, unknown>)[field]
    const store = component.$soa[field] as
      | { from?: (entity: number, data: unknown) => void; resize?: (n: number) => void }
      | undefined
    if (!store) continue
    if (typeof store.resize === 'function') store.resize(entity + 1)
    if (typeof store.from === 'function') {
      store.from(entity, v)
    } else if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      // Plain typed-array field (Float32, Int32, …) — write at index `entity`
      ;(store as unknown as { [k: number]: number })[entity] =
        (v as unknown as ArrayLike<number>)[0] ?? (v as unknown as number)
    } else if (typeof v === 'number') {
      ;(store as unknown as { [k: number]: number })[entity] = v
    }
  }
}

const readSoA = (component: ComponentDefinition, entity: Entity, into: Record<string, unknown>): void => {
  for (const field of component.$soaFields) {
    const store = component.$soa[field] as { to?: (entity: number, out?: unknown) => unknown } | undefined
    if (!store) continue
    if (typeof store.to === 'function') {
      into[field] = store.to(entity)
    } else {
      into[field] = (store as unknown as { [k: number]: number })[entity]
    }
  }
}

export const setComponent = <T extends TSchema>(
  world: World,
  entity: Entity,
  component: ComponentDefinition<T>,
  value: Partial<Static<T>> = {} as Partial<Static<T>>,
  options: SetComponentOptions = {}
): void => {
  ensureRegistered(world, component as ComponentDefinition)
  const origin: Origin = options.origin ?? 'local'
  const wasPresent = bitecs.hasComponent(world, entity, component.$ref)

  if (!wasPresent) {
    bitecs.addComponent(world, entity, component.$ref)
    // Materialise instance from defaults + override
    const merged: Record<string, unknown> = { ...component.$defaults }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) merged[k] = v
    // Fill in missing defaults from schema (TypeBox handles nested defaults)
    const initialised = Value.Default(component.$schema, merged) as Record<string, unknown>
    // Split into SoA writes and instance store
    const instance: Record<string, unknown> = {}
    for (const field of component.$valueFields) {
      if (field in initialised) instance[field] = initialised[field]
    }
    component.$store[entity] = instance
    writeSoA(component as ComponentDefinition, entity, initialised)
  } else {
    // Partial shallow merge of instance fields
    const instance = component.$store[entity] ?? {}
    for (const field of component.$valueFields) {
      if (field in (value as Record<string, unknown>)) {
        instance[field] = (value as Record<string, unknown>)[field]
      }
    }
    component.$store[entity] = instance
    writeSoA(component as ComponentDefinition, entity, value as Record<string, unknown>)
  }

  // Mutation pipeline hooks
  if (component.mutationCategory === 'runtime') markRuntimeDirty(world, entity, component.id)

  world.trace.emit({
    kind: 'component.set',
    ts: world.clock.now(),
    entity,
    predicate: component.id,
    origin
  })
}

export const getComponent = <T extends TSchema>(
  world: World,
  entity: Entity,
  component: ComponentDefinition<T>
): Static<T> | undefined => {
  if (!bitecs.hasComponent(world, entity, component.$ref)) return undefined
  const result: Record<string, unknown> = { ...component.$store[entity] }
  readSoA(component as ComponentDefinition, entity, result)
  return result as Static<T>
}

export const hasComponent = (world: World, entity: Entity, component: ComponentDefinition): boolean =>
  bitecs.hasComponent(world, entity, component.$ref)

export const removeComponent = <T extends TSchema>(
  world: World,
  entity: Entity,
  component: ComponentDefinition<T>,
  options: SetComponentOptions = {}
): void => {
  if (!bitecs.hasComponent(world, entity, component.$ref)) return
  const origin: Origin = options.origin ?? 'local'
  bitecs.removeComponent(world, entity, component.$ref)
  delete component.$store[entity]
  if (component.mutationCategory === 'runtime') clearRuntimeDirty(world, entity, component.id)
  world.trace.emit({
    kind: 'component.remove',
    ts: world.clock.now(),
    entity,
    predicate: component.id,
    origin
  })
}

// ── Runtime dirty flag helpers (consumed by mutation.ts runtime pipeline) ─────

export const markRuntimeDirty = (world: World, entity: Entity, componentId: string): void => {
  let set = world.runtimeDirty.get(componentId)
  if (!set) {
    set = new Set()
    world.runtimeDirty.set(componentId, set)
  }
  set.add(entity)
}

export const clearRuntimeDirty = (world: World, entity: Entity, componentId: string): void => {
  const set = world.runtimeDirty.get(componentId)
  if (set) set.delete(entity)
}

export const drainRuntimeDirty = (world: World): Map<string, Set<Entity>> => {
  const drained = new Map<string, Set<Entity>>()
  for (const [id, set] of world.runtimeDirty) {
    if (set.size > 0) {
      drained.set(id, new Set(set))
      set.clear()
    }
  }
  return drained
}
