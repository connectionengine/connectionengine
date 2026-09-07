/**
 * ComponentDefinition — schema-driven, and it carries a SHACL shape.
 *
 * One `defineComponent({ id, label, schema, sync? })` produces three things:
 *   - SoA stores (typed arrays) for the SoA-tagged fields (Vec3, Quat,
 *     Float32, ...). They go directly onto the ComponentDefinition object, so
 *     `Transform.position.x[eid]` gives the bitECS-style hot path with no
 *     indirection.
 *   - A per-entity instance store for the value-typed fields (string, boolean,
 *     ...). It lives on the Engine, keyed by component and entity.
 *   - A ComponentSchema (jsonSchema + shaclShape). It holds the replication
 *     metadata, and attaches to the definition as `$componentSchema`.
 *
 * Definitions are module-level singletons. They are global, not per-engine.
 * Every engine that uses the component shares one `ComponentDefinition`
 * object. Per-engine storage lives in `engine.componentStores`.
 *
 * Storage shape:
 *   - SoA arrays    → on the definition itself. One source of truth, shared by
 *                     every engine that uses the component.
 *   - Instance map  → on the engine, per (component, entity). One stable object
 *                     reference per entity.
 *
 * `getComponent` returns a stable per-entity object. For a value-only
 * component it returns the instance store itself. Otherwise it returns a cached
 * view bag that delegates to the SoA arrays, and, for a mixed component, to the
 * instance store as well.
 *
 * How a component replicates follows from its schema, on one rule:
 *
 *   **Existence is governed. Values are governed only where they are discrete.**
 *
 * Creation or removal of any synced component authors an event, whatever the
 * schema holds, because creation and removal are causal. A write to a
 * value-typed field authors an event too. The creating event carries the whole
 * component, so even the initial SoA state passes the gate. Only one case
 * escapes: a write to the SoA fields of a component that already exists. Those
 * writes ride the binary delta channel (see `hasSyncedSoA`). That channel may
 * modify a component, but it never creates one, which `network/binary.ts`
 * enforces.
 *
 * Continuous constraints belong in systems. A system makes an invalid state
 * unreachable rather than inadmissible. Mixing both kinds of field in one
 * component has one cost: the two halves travel at different cadences, so
 * `getComponent` can return an object whose halves come from different moments.
 *
 * All meta fields on the definition use a `$` prefix (`$id`, `$schema`,
 * `$sync`, ...). The bare keys therefore stay reserved for schema fields.
 *
 * Extension properties: `defineComponent` spreads any field on the options
 * object that is not a reserved key (`id`, `label`, `schema`, `sync`) straight
 * onto the definition, and preserves its type. Built-in components use this to
 * attach their own indexes, such as `UIDComponent.nameCache` and
 * `UIDComponent.uidOf`. User code can do the same.
 */

import * as bitecs from 'bitecs'
import { Kind, type Static, type TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { resizableArray, type ResizableArray, type TypedArrayConstructor } from '../maths/common'
import type { ArrayBufferKind, SoAStoreKind } from '../schema/kinds'
import type { World, Entity } from './world'
import type { Engine } from './engine'
import type { Origin } from './world'

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Shareable replication metadata. Attached directly to its
 * `ComponentDefinition` as `$componentSchema`.
 */
export interface ComponentSchema {
  readonly id: string
  readonly jsonSchema: object
  readonly shaclShape: object
}

export interface ComponentOptions<T extends TSchema = TSchema> {
  id: string
  label?: string
  schema: T
  /** Whether this component replicates across the network. Default `true`. */
  sync?: boolean
}

/** Reserved option keys that `defineComponent` consumes itself. Every other key
 *  passed to `defineComponent` becomes a typed extension property on the
 *  resulting definition. */
type ReservedComponentOptionKey = keyof ComponentOptions

/** Fields on an options object that do *not* belong to `ComponentOptions`.
 *  `defineComponent` passes these straight through onto the definition. */
export type ComponentExtensions<O> = Omit<O, ReservedComponentOptionKey>

/**
 * Meta fields on a ComponentDefinition. All of them use a `$` prefix, so the
 * bare keys on the definition stay reserved for the SoA stores that come from
 * the schema.
 */
export interface ComponentDefinitionMeta<T extends TSchema = TSchema> {
  readonly $id: string
  readonly $label: string
  readonly $schema: T
  /** Whether this component replicates. Defaults to `true` at definition time. */
  readonly $sync: boolean
  readonly $componentSchema: ComponentSchema
  /** Default values per field, applied on first set. */
  readonly $defaults: Record<string, unknown>
  /** Internal: bitECS component ref for query/has/add. */
  readonly $ref: bitecs.ComponentRef
  /** Internal: field names tagged as SoA. */
  readonly $soaFields: readonly string[]
  /** Internal: value-typed (instance store) field names. */
  readonly $valueFields: readonly string[]
}

/**
 * Does this component put state on the binary delta channel?
 *
 * No counterpart function asks "does it author?", because every synced
 * component authors. Existence is always causal. Only continuous *values*
 * escape the gate.
 */
export const hasSyncedSoA = (component: Pick<ComponentDefinitionMeta, '$sync' | '$soaFields'>): boolean =>
  component.$sync && component.$soaFields.length > 0

/**
 * Map one schema field to the SoA store type that it produces at runtime.
 *   - SoAStoreKind<_, _, C>      → C (for example Vec3SoA<...>, QuatSoA<...>)
 *   - ArrayBufferKind            → ResizableArray<TypedArrayConstructor>
 *   - Anything else (value type) → never
 */
export type SoAStoreOf<P> =
  P extends SoAStoreKind<TypedArrayConstructor, unknown, infer C>
    ? C
    : P extends ArrayBufferKind<unknown>
      ? ResizableArray<TypedArrayConstructor>
      : never

/**
 * Walk the `properties` of a component schema and keep only the SoA-tagged
 * fields. Type each one as its concrete SoA store class. The intersection with
 * a string index signature lets `ComponentDefinition<SpecificT>` flow up to the
 * default `ComponentDefinition`, which uses `TSchema`. Narrow types survive
 * when the schema is known.
 */
export type SoAStores<T extends TSchema> = T extends { properties: infer Props }
  ? {
      readonly [K in keyof Props as Props[K] extends TSchema
        ? [SoAStoreOf<Props[K]>] extends [never]
          ? never
          : K
        : never]: Props[K] extends TSchema ? SoAStoreOf<Props[K]> : never
    } & Readonly<Record<string, unknown>>
  : Readonly<Record<string, unknown>>

/**
 * A ComponentDefinition holds the meta interface PLUS the SoA stores, which sit
 * as direct properties on the same object. For `Transform { position: Vec3,
 * rotation: Quat }`, `Transform.position` is a `Vec3SoA`. Use it directly as
 * `Transform.position.x[eid]` or as `Transform.position.view(eid)`.
 */
export type ComponentDefinition<T extends TSchema = TSchema> = ComponentDefinitionMeta<T> & SoAStores<T>

/**
 * Per-field write shape. An SoA-tagged field accepts an ArrayLike, such as
 * `[1, 2, 3]` or a typed array, or the view shape. The value parameter of
 * `setComponent` widens to this shape, so a caller can pass a plain array even
 * though the canonical static type is the View.
 */
export type WriteValueOf<P> =
  P extends SoAStoreKind<TypedArrayConstructor, infer S, unknown>
    ? S | ArrayLike<number>
    : P extends ArrayBufferKind<unknown>
      ? number | ArrayLike<number>
      : P extends TSchema
        ? Static<P>
        : never

/** Write-side shape for the `setComponent` value parameter. It widens to accept
 *  arrays for the SoA fields. */
export type ComponentWriteShape<T extends TSchema> = T extends { properties: infer Props }
  ? { [K in keyof Props]?: WriteValueOf<Props[K]> }
  : Partial<Static<T>>

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

const toShaclShape = (id: string, schema: TSchema): object => {
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
    properties
  }
}

// ── Global component registry ────────────────────────────────────────────────-
//
// Component definitions are module-level singletons. They are global, not
// per-engine. Each engine holds its own STORAGE, in componentStores keyed by
// definition, but the definition itself is one JS object that every engine
// shares. A component defined at module load therefore works for any engine
// that starts or stops later, and needs no per-engine registration step.

const componentsById = new Map<string, ComponentDefinition>()
const componentsByRef = new WeakMap<bitecs.ComponentRef, ComponentDefinition>()

// ── defineComponent ───────────────────────────────────────────────────────────

export const defineComponent = <O extends ComponentOptions<TSchema>>(
  options: O
): ComponentDefinition<O['schema']> & ComponentExtensions<O> => {
  type T = O['schema']
  const {
    id,
    label = id,
    schema,
    sync = true,
    ...extensions
  } = options as ComponentOptions<T> & Record<string, unknown>
  const existing = componentsById.get(id)
  if (existing) return existing as ComponentDefinition<T> & ComponentExtensions<O>
  const { soaFields, valueFields } = classifyFields(schema)

  const $defaults = buildDefaults(schema)
  const $ref: bitecs.ComponentRef = { __ce: id } as bitecs.ComponentRef

  const $componentSchema: ComponentSchema = {
    id,
    jsonSchema: schema as object,
    shaclShape: toShaclShape(id, schema)
  }

  const soaStores = buildSoAStores(schema)

  const meta: ComponentDefinitionMeta<T> = {
    $id: id,
    $label: label,
    $schema: schema,
    $sync: sync,
    $componentSchema,
    $defaults,
    $ref,
    $soaFields: soaFields,
    $valueFields: valueFields
  }

  const definition = { ...meta, ...soaStores, ...extensions } as unknown as ComponentDefinition<T> &
    ComponentExtensions<O>

  componentsByRef.set($ref, definition as ComponentDefinition)
  componentsById.set(id, definition as ComponentDefinition)
  return definition
}

/** Resolve a ComponentDefinition from its bitECS ref. */
export const getComponentDefinition = (ref: bitecs.ComponentRef): ComponentDefinition | undefined =>
  componentsByRef.get(ref)

/** Resolve a ComponentDefinition by its id. */
export const getComponentById = (id: string): ComponentDefinition | undefined => componentsById.get(id)

/** Iterate every ComponentDefinition ever defined. */
export const allComponents = (): ComponentDefinition[] => Array.from(componentsById.values())

// ── Engine-level instance + view storage ──────────────────────────────────────

/**
 * Per-component engine-level storage. The SoA arrays live on the definition.
 * This structure holds only the data that is per-(component, entity) but *not*
 * per-axis:
 *
 *   - `store` — instance map for value-typed components (event channel).
 *   - `views` — cached per-entity bag for continuous components. Each bag is
 *               allocated once. Its fields are the SoA `.view(entity)`
 *               projections, which are cached too. `getComponent` returns it.
 */
export interface PerComponentStores {
  store: Record<Entity, Record<string, unknown>>
  views: Record<Entity, Record<string, unknown>>
}

const getStores = (engine: Engine, component: ComponentDefinition): PerComponentStores => {
  let stores = engine.componentStores.get(component)
  if (!stores) {
    stores = { store: {}, views: {} }
    engine.componentStores.set(component, stores)
  }
  return stores
}

/** Public accessor for the engine-level per-entity instance map, which holds the
 *  value-typed fields. */
export const getInstanceStore = (
  world: World,
  component: ComponentDefinition
): Record<Entity, Record<string, unknown>> => getStores(world.engine, component).store

// ── set / get / remove ────────────────────────────────────────────────────────

export interface SetComponentOptions {
  /** Origin tag for the mutation pipeline. 'local', the default, goes outbound.
   *  'network' stays suppressed. */
  origin?: Origin
}

/**
 * Structural view of an SoA store — Vec3SoA, QuatSoA, a bare typed array, and
 * so on — as this module uses it. The stores sit on the definition itself, and
 * `soaStoresOf` casts the definition to expose them.
 */
interface SoAStoreLike {
  from?: (entity: number, data: ArrayLike<number>) => void
  to?: (entity: number) => ArrayLike<number>
  view?: (entity: number) => unknown
  resize?: (n: number) => void
}

const soaStoresOf = (component: ComponentDefinition): Record<string, SoAStoreLike | undefined> =>
  component as unknown as Record<string, SoAStoreLike | undefined>

const writeSoA = (component: ComponentDefinition, entity: Entity, value: Record<string, unknown>): void => {
  const stores = soaStoresOf(component)
  for (const field of component.$soaFields) {
    if (!(field in value)) continue
    const v = (value as Record<string, unknown>)[field]
    const store = stores[field]
    if (!store) continue
    if (typeof store.resize === 'function') store.resize(entity + 1)
    if (typeof store.from === 'function') {
      store.from(entity, v as ArrayLike<number>)
    } else if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      ;(store as unknown as { [k: number]: number })[entity] =
        (v as unknown as ArrayLike<number>)[0] ?? (v as unknown as number)
    } else if (typeof v === 'number') {
      ;(store as unknown as { [k: number]: number })[entity] = v
    }
  }
}

export const setComponent = <T extends TSchema>(
  world: World,
  entity: Entity,
  component: ComponentDefinition<T>,
  value: ComponentWriteShape<T> = {} as ComponentWriteShape<T>,
  options: SetComponentOptions = {}
): void => {
  const stores = getStores(world.engine, component as ComponentDefinition)
  const origin: Origin = options.origin ?? 'local'
  const wasPresent = bitecs.hasComponent(world.engine.bitECS, entity, component.$ref)

  if (!wasPresent) {
    bitecs.addComponent(world.engine.bitECS, entity, component.$ref)
    const merged: Record<string, unknown> = { ...component.$defaults }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) merged[k] = v
    const initialised = Value.Default(component.$schema, merged) as Record<string, unknown>
    // Reuse an existing instance object, so that references held earlier
    // survive a remove and add cycle. Otherwise allocate one.
    let instance = stores.store[entity]
    if (!instance) {
      instance = {}
      stores.store[entity] = instance
    } else {
      for (const k of Object.keys(instance)) delete instance[k]
    }
    for (const field of component.$valueFields) {
      if (field in initialised) instance[field] = initialised[field]
    }
    writeSoA(component as ComponentDefinition, entity, initialised)
  } else {
    const instance = stores.store[entity] ?? (stores.store[entity] = {})
    for (const field of component.$valueFields) {
      if (field in (value as Record<string, unknown>)) {
        instance[field] = (value as Record<string, unknown>)[field]
      }
    }
    writeSoA(component as ComponentDefinition, entity, value as Record<string, unknown>)
  }

  if (origin === 'local' && component.$sync) {
    if (hasSyncedSoA(component)) markRuntimeDirty(world, entity, component.$id)
    // Two occasions author. The first is the creation of the component. The
    // second is any write that names a discrete field. A write that only moves
    // SoA fields on a component that already exists is the per-tick case, and
    // it rides the binary channel alone.
    const touchesDiscrete = component.$valueFields.some((f) => f in (value as Record<string, unknown>))
    if (!wasPresent || touchesDiscrete) {
      world.authoredQueue.push({
        entity,
        predicate: component.$id,
        op: 'set',
        value: serialiseComponentValue(world, entity, component as ComponentDefinition),
        origin
      })
    }
  }
}

/**
 * Read the component value for `entity`. This returns a **stable reference**.
 * Repeated calls to `getComponent` for the same (component, entity) return the
 * same JS object. Each SoA field inside it (Vec3, Quat, …) behaves the same
 * way. Each one is a getter-backed view that delegates straight to the SoA
 * arrays, so the values stay live and need no refresh step.
 *
 * For an event-channel component, the returned object IS the instance store,
 * which is allocated once per entity. For a continuous-channel component, it is
 * a cached view bag whose fields are `SoA.view(entity)` projections, which are
 * also cached. The hot path therefore allocates nothing.
 *
 * A write through the SoA-field accessors of the returned object reaches the
 * underlying typed arrays. A write to a value-typed field on the event instance
 * does NOT pass through `setComponent`. Write those fields with `setComponent`,
 * so that the mutation pipeline collects them.
 */
export const getComponent = <T extends TSchema>(
  world: World,
  entity: Entity,
  component: ComponentDefinition<T>
): Static<T> | undefined => {
  if (!bitecs.hasComponent(world.engine.bitECS, entity, component.$ref)) return undefined
  const def = component as ComponentDefinition
  const stores = getStores(world.engine, def)
  if (def.$soaFields.length === 0) {
    // Event-channel component. The instance store IS the live data.
    return stores.store[entity] as Static<T>
  }
  return (stores.views[entity] ??= buildView(def, stores, entity)) as Static<T>
}

/**
 * Build the cached per-entity view bag. Each SoA field becomes a live
 * `.view(entity)` projection, or a getter and setter pair for a scalar store.
 * Each value field delegates to the instance store.
 *
 * Those value accessors read `stores.store[entity]` again on every access, and
 * do not capture the instance. `removeComponent` drops that instance, and a
 * later `setComponent` can install a different one. A view held across that
 * cycle would otherwise write into an orphan.
 */
const buildView = (def: ComponentDefinition, stores: PerComponentStores, entity: Entity): Record<string, unknown> => {
  const view: Record<string, unknown> = {}
  const delegate = (field: string, get: () => unknown, set: (v: never) => void): void => {
    Object.defineProperty(view, field, { get, set, enumerable: true })
  }
  for (const field of def.$valueFields) {
    delegate(
      field,
      () => stores.store[entity]?.[field],
      (v) => ((stores.store[entity] ??= {})[field] = v)
    )
  }
  const soaStores = soaStoresOf(def)
  for (const field of def.$soaFields) {
    const soa = soaStores[field]
    if (typeof soa?.view === 'function') view[field] = soa.view(entity)
    // Scalar SoA. The store is the typed array itself, indexed by entity.
    else if (soa) {
      const arr = soa as unknown as Record<number, number>
      delegate(
        field,
        () => arr[entity],
        (n: never) => (arr[entity] = n)
      )
    }
  }
  return view
}

const deepPlain = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>)
  if (Array.isArray(value)) return value.map(deepPlain)
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, deepPlain(v)]))
}

/**
 * Read a component as plain, JSON-safe data. Value fields come back as deep
 * copies, and SoA fields come back as number arrays. This is the shape that
 * travels in an authored event and in a `Snapshot`. It differs from
 * `getComponent` in two ways: it allocates, and it captures the values as they
 * are *now* instead of staying live.
 */
export const serialiseComponentValue = (
  world: World,
  entity: Entity,
  component: ComponentDefinition
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  const instance = getStores(world.engine, component).store[entity]
  const soaStores = soaStoresOf(component)
  for (const field of component.$valueFields) {
    if (instance && field in instance) out[field] = deepPlain(instance[field])
  }
  for (const field of component.$soaFields) {
    const soa = soaStores[field]
    if (typeof soa?.to === 'function') out[field] = Array.from(soa.to(entity))
  }
  return out
}

export const hasComponent = (world: World, entity: Entity, component: ComponentDefinition): boolean =>
  bitecs.hasComponent(world.engine.bitECS, entity, component.$ref)

export const removeComponent = <T extends TSchema>(
  world: World,
  entity: Entity,
  component: ComponentDefinition<T>,
  options: SetComponentOptions = {}
): void => {
  if (!bitecs.hasComponent(world.engine.bitECS, entity, component.$ref)) return
  const stores = getStores(world.engine, component as ComponentDefinition)
  const origin: Origin = options.origin ?? 'local'
  bitecs.removeComponent(world.engine.bitECS, entity, component.$ref)
  delete stores.store[entity]
  delete stores.views[entity]
  if (hasSyncedSoA(component)) clearRuntimeDirty(world, entity, component.$id)
  // Removal is causal, so it always authors. It emits one event, which carries
  // whichever halves the component held.
  if (origin === 'local' && component.$sync) {
    world.authoredQueue.push({
      entity,
      predicate: component.$id,
      op: 'remove',
      value: null,
      origin
    })
  }
}

// ── Runtime dirty flag helpers. The runtime pipeline in mutation.ts uses them ─

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
