/**
 * ComponentDefinition — schema-driven, SHACL-shape-bearing.
 *
 * One `defineComponent({ id, label, schema, sync?, engine? })` produces:
 *   - SoA stores (typed arrays) for SoA-tagged fields (Vec3, Quat, Float32, ...).
 *     These are spread directly onto the ComponentDefinition object — so you
 *     can write `Transform.position.x[eid]` for the bitECS-style hot path with
 *     zero indirection.
 *   - per-entity instance store for value-typed fields (string, boolean, ...).
 *     Lives on the Engine, keyed by component+entity.
 *   - a ComponentSchema (jsonSchema + shaclShape + channel) registered in the
 *     engine's schema map for replication metadata.
 *
 * Storage shape:
 *   - SoA arrays    → on the definition itself, single source of truth, shared
 *                     across worlds attached to the same engine.
 *   - Instance map  → on the engine, per (component, entity). Stable object
 *                     reference per entity.
 *
 * `getComponent` returns:
 *   - For event components:      the instance object directly (live data).
 *   - For continuous components: a cached per-entity view bag whose fields are
 *                                the SoA `.view(entity)` projections. Same
 *                                object every call, no refresh, no allocation,
 *                                always-live via getter/setter delegation.
 *
 * The replication channel is derived from the schema alone:
 *   - any SoA-tagged field  → `continuous` (binary delta path, no event log,
 *                              last-write-wins, no governance gate)
 *   - else                  → `event`      (authored path: event-sourced,
 *                              signed, governance-validated, replayed on
 *                              late join)
 *   - `sync: false`         → `local`      (never replicated)
 *
 * Schema-only is strict: mixing SoA and non-SoA fields in one component throws
 * at definition. Split it instead.
 *
 * All meta fields on the definition use a `$` prefix (`$id`, `$schema`,
 * `$channel`, ...) so the bare keys are reserved for schema fields.
 */

import * as bitecs from 'bitecs'
import { Kind, type Static, type TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { resizableArray, type ResizableArray, type TypedArrayConstructor } from '../maths/common'
import type { ArrayBufferKind, SoAStoreKind } from '../schema/kinds'
import type { World, Entity } from './world'
import type { Engine } from './engine'
import { getDefaultEngine } from './engine'
import type { Origin } from './trace'

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Shareable replication metadata. One entry per component lives in
 * `engine.schemas`, keyed by component id.
 */
export interface ComponentSchema {
  readonly id: string
  readonly jsonSchema: object
  readonly shaclShape: object
  /**
   * Replication channel — derived from the schema in `defineComponent`.
   * `event` for authored events, `continuous` for binary delta SoA fields,
   * `local` if the component is opted out of replication.
   */
  readonly channel: 'event' | 'continuous' | 'local'
}

/**
 * Replication channel for a component. Derived from the schema:
 *   - `'continuous'` — has SoA-tagged fields, ships via binary delta pipeline,
 *                      not in event log, last-write-wins.
 *   - `'event'`      — no SoA fields, ships as authored event, in event log,
 *                      signed, replayed on late join.
 *   - `'local'`      — opt-out via `defineComponent({ sync: false })`. Never
 *                      replicates.
 */
export type ReplicationChannel = 'event' | 'continuous' | 'local'

export interface ComponentOptions<T extends TSchema = TSchema> {
  id: string
  label?: string
  schema: T
  /** Whether this component replicates across the network. Default `true`. */
  sync?: boolean
  /** Engine to register against. Defaults to the ambient engine. */
  engine?: Engine
}

/**
 * Meta fields on a ComponentDefinition. All prefixed `$` so the bare keys on
 * the definition are reserved for SoA stores spread from the schema.
 */
export interface ComponentDefinitionMeta<T extends TSchema = TSchema> {
  readonly $id: string
  readonly $label: string
  readonly $schema: T
  /** Whether this component replicates. Defaults to `true` at definition time. */
  readonly $sync: boolean
  /** Replication channel — derived from schema + `$sync`. */
  readonly $channel: ReplicationChannel
  /** True iff this component uses the binary delta path. */
  readonly $isBinary: boolean
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
 * Map a single schema field to the SoA store type it would produce at runtime.
 *   - SoAStoreKind<_, _, C>      → C (e.g. Vec3SoA<...>, QuatSoA<...>)
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
 * Walk a component schema's `properties` and keep only the SoA-tagged fields,
 * each typed as its concrete SoA store class. The intersection with a string
 * index signature lets `ComponentDefinition<SpecificT>` flow up to the default
 * `ComponentDefinition` (which uses `TSchema`) while still preserving narrow
 * types when the schema is known.
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
 * A ComponentDefinition is the meta interface PLUS the SoA stores spread as
 * direct properties on the same object. For `Transform { position: Vec3,
 * rotation: Quat }`, `Transform.position` is a `Vec3SoA` — usable directly as
 * `Transform.position.x[eid]` and `Transform.position.view(eid)`.
 */
export type ComponentDefinition<T extends TSchema = TSchema> = ComponentDefinitionMeta<T> & SoAStores<T>

/**
 * Per-field write shape. SoA-tagged fields accept either an ArrayLike (e.g.
 * `[1, 2, 3]`, a typed array) or the view shape — `setComponent`'s value
 * parameter widens to this so callers can pass plain arrays despite the
 * canonical static type being the View.
 */
export type WriteValueOf<P> =
  P extends SoAStoreKind<TypedArrayConstructor, infer S, unknown>
    ? S | ArrayLike<number>
    : P extends ArrayBufferKind<unknown>
      ? number | ArrayLike<number>
      : P extends TSchema
        ? Static<P>
        : never

/** Write-side shape for `setComponent` value param — widened to accept arrays for SoA fields. */
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

const toShaclShape = (id: string, schema: TSchema, channel: ReplicationChannel): object => {
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
    channel,
    properties
  }
}

// ── defineComponent ───────────────────────────────────────────────────────────

export const defineComponent = <T extends TSchema>(options: ComponentOptions<T>): ComponentDefinition<T> => {
  const engine = options.engine ?? getDefaultEngine()
  const { id, label = id, schema, sync = true } = options
  const existing = engine.components.get(id)
  if (existing) return existing as ComponentDefinition<T>
  const { soaFields, valueFields } = classifyFields(schema)

  if (soaFields.length > 0 && valueFields.length > 0) {
    throw new Error(
      `defineComponent('${id}'): components cannot mix SoA-tagged fields (${soaFields.join(
        ', '
      )}) with value-typed fields (${valueFields.join(
        ', '
      )}). Split into two components — SoA fields ship via the binary delta channel; value-typed fields ship as authored events.`
    )
  }

  const $defaults = buildDefaults(schema)
  const isBinary = sync && soaFields.length > 0
  const channel: ReplicationChannel = !sync ? 'local' : isBinary ? 'continuous' : 'event'

  const $ref: bitecs.ComponentRef = { __ce: id } as bitecs.ComponentRef

  const $componentSchema: ComponentSchema = {
    id,
    jsonSchema: schema as object,
    shaclShape: toShaclShape(id, schema, channel),
    channel
  }

  const soaStores = buildSoAStores(schema)

  const meta: ComponentDefinitionMeta<T> = {
    $id: id,
    $label: label,
    $schema: schema,
    $sync: sync,
    $channel: channel,
    $isBinary: isBinary,
    $componentSchema,
    $defaults,
    $ref,
    $soaFields: soaFields,
    $valueFields: valueFields
  }

  const definition = { ...meta, ...soaStores } as ComponentDefinition<T>

  engine.componentsByRef.set($ref, definition as ComponentDefinition)
  engine.components.set(id, definition as ComponentDefinition)
  engine.schemas.set(id, $componentSchema)
  return definition
}

/** Resolve a ComponentDefinition from its bitECS ref. Uses the world's engine. */
export const getComponentDefinition = (
  worldOrEngine: World | Engine,
  ref: bitecs.ComponentRef
): ComponentDefinition | undefined => engineOf(worldOrEngine).componentsByRef.get(ref)

/** Resolve a ComponentDefinition by its id. Uses the world's engine if given, else the ambient engine. */
export const getComponentById = (id: string, engine?: Engine): ComponentDefinition | undefined =>
  (engine ?? getDefaultEngine()).components.get(id)

/** Iterate every ComponentDefinition defined on the given engine (default: ambient). */
export const allComponents = (engine?: Engine): ComponentDefinition[] =>
  Array.from((engine ?? getDefaultEngine()).components.values())

const engineOf = (worldOrEngine: World | Engine): Engine =>
  'bitECS' in worldOrEngine ? worldOrEngine : worldOrEngine.engine

// ── Engine-level instance + view storage ──────────────────────────────────────

/**
 * Per-component engine-level storage. SoA arrays live on the definition; this
 * holds only what's per-(component, entity) but *not* per-axis:
 *
 *   - `store` — instance map for value-typed components (event channel).
 *   - `views` — cached per-entity bag for continuous components. Each entity's
 *               bag is allocated once and its fields are the SoA `.view(entity)`
 *               projections (themselves cached). Returned by `getComponent`.
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

/** Public accessor — engine-level per-entity instance map (value-typed fields). */
export const getInstanceStore = (
  world: World,
  component: ComponentDefinition
): Record<Entity, Record<string, unknown>> => getStores(world.engine, component).store

/**
 * Iterate every entity in `world` that currently has the component. Filters the
 * engine-level instance map by `world.entities` membership.
 */
export const componentEntities = (world: World, component: ComponentDefinition): Entity[] => {
  const store = getStores(world.engine, component).store
  const out: Entity[] = []
  for (const key of Object.keys(store)) {
    const e = Number(key)
    if (world.entities.has(e)) out.push(e)
  }
  return out
}

// ── set / get / remove ────────────────────────────────────────────────────────

export interface SetComponentOptions {
  /** Origin tag for the mutation pipeline. 'local' (default) is outbound; 'network' is suppressed. */
  origin?: Origin
}

interface SoAStoreLike {
  from?: (entity: number, data: ArrayLike<number>) => void
  resize?: (n: number) => void
}

const writeSoA = (component: ComponentDefinition, entity: Entity, value: Record<string, unknown>): void => {
  const stores = component as unknown as Record<string, SoAStoreLike | undefined>
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
    // Reuse any existing instance object so previously held references survive
    // a remove + add cycle. Otherwise allocate once.
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
    if (component.$isBinary) {
      markRuntimeDirty(world, entity, component.$id)
    } else {
      world.authoredQueue.push({
        entity,
        predicate: component.$id,
        op: 'set',
        value: getComponent(world, entity, component),
        origin
      })
    }
  }

  world.trace.emit({
    kind: 'component.set',
    ts: world.clock.now(),
    entity,
    predicate: component.$id,
    origin
  })
}

interface SoAViewSource {
  view?: (entity: number) => unknown
}

/**
 * Read the component value for `entity`. Returns a **stable reference** —
 * calling `getComponent` repeatedly for the same (component, entity) returns
 * the same JS object. Same for any SoA field inside it (Vec3, Quat, …): each
 * is a getter-backed view that delegates straight to the SoA arrays, so values
 * are always live without any refresh step.
 *
 * For event-channel components this IS the instance store (one allocation
 * per entity, ever). For continuous-channel components this is a cached view
 * bag whose fields are `SoA.view(entity)` projections (also cached). No
 * allocation on the hot path.
 *
 * Mutating the returned object via the SoA-field accessors writes through to
 * the underlying typed arrays. Mutating value-typed fields on the event
 * instance does NOT flow through `setComponent` — those should be written via
 * `setComponent` so the mutation pipeline picks them up.
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
    // Event-channel component: instance store IS the live data.
    return stores.store[entity] as Static<T>
  }
  let view = stores.views[entity]
  if (!view) {
    view = {}
    const soaStores = def as unknown as Record<string, SoAViewSource | undefined>
    for (const field of def.$soaFields) {
      const soa = soaStores[field]
      if (soa && typeof soa.view === 'function') {
        view[field] = soa.view(entity)
      } else if (soa) {
        // Scalar SoA — expose a getter/setter that delegates to typed array index.
        const arr = soa as unknown as { [k: number]: number }
        Object.defineProperty(view, field, {
          get: () => arr[entity],
          set: (n: number) => {
            arr[entity] = n
          },
          enumerable: true
        })
      }
    }
    stores.views[entity] = view
  }
  return view as Static<T>
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
  if (component.$isBinary) clearRuntimeDirty(world, entity, component.$id)
  if (origin === 'local' && component.$sync && !component.$isBinary) {
    world.authoredQueue.push({
      entity,
      predicate: component.$id,
      op: 'remove',
      value: null,
      origin
    })
  }
  world.trace.emit({
    kind: 'component.remove',
    ts: world.clock.now(),
    entity,
    predicate: component.$id,
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
