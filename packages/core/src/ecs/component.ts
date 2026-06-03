/**
 * ComponentDefinition — schema-driven, SHACL-shape-bearing.
 *
 * One `defineComponent({ id, label, schema, local? })` produces:
 *   - SoA stores (typed arrays) for SoA-tagged fields (Vec3, Quat, Float32, ...)
 *   - per-entity instance store for value-typed fields (string, boolean, ...)
 *   - a ComponentSchema (jsonSchema + shaclShape + channel) registered with the
 *     world's schema map for replication metadata
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
 * at definition. Split it instead — a `Transform { position, rotation }` for
 * continuous, a separate `Label { text }` for events.
 *
 * setComponent / getComponent / removeComponent operate against bitECS storage
 * + our instance store, fire observers, and feed the mutation pipeline.
 */

import * as bitecs from 'bitecs'
import { Kind, type Static, type TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { resizableArray } from '../maths/common'
import type { ArrayBufferKind, SoAStoreKind } from '../schema/kinds'
import type { World, Entity } from './world'
import type { Origin } from './trace'

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Shareable replication metadata. One entry per component lives in
 * `world.network.schemas`, keyed by component id.
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
  /**
   * Whether this component replicates across the network. Default `true`.
   * Set to `false` to keep the component machine-local — no events, no
   * binary packets, no SHACL `channel` other than `'local'`.
   */
  sync?: boolean
}

export interface ComponentDefinition<T extends TSchema = TSchema> {
  readonly id: string
  readonly label: string
  readonly $schema: T
  /** Whether this component replicates. Defaults to `true` at definition time. */
  readonly sync: boolean
  /** Replication channel — derived from schema + `sync`. */
  readonly channel: ReplicationChannel
  /** True iff this component uses the binary delta path. */
  readonly isBinary: boolean
  readonly componentSchema: ComponentSchema
  /** Default values per field, applied on first set. */
  readonly $defaults: Record<string, unknown>
  /** Internal: bitECS component ref for query/has/add. */
  readonly $ref: bitecs.ComponentRef
  /** Internal: field names tagged as SoA — used by mutation pipeline + serializer. */
  readonly $soaFields: readonly string[]
  /** Internal: value-typed (instance store) field names. */
  readonly $valueFields: readonly string[]
  /** Internal: factory for the per-world SoA stores (typed arrays + helpers). */
  readonly $createSoA: () => Record<string, unknown>
}

/** Per-world storage for one component: SoA stores + per-entity instance values. */
interface PerWorldStores {
  soa: Record<string, unknown>
  store: Record<Entity, Record<string, unknown>>
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

const makeSoAStoreFactory = (schema: TSchema): (() => Record<string, unknown>) => {
  return () => {
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
    channel,
    properties
  }
}

// ── defineComponent ───────────────────────────────────────────────────────────

const componentByRef = new WeakMap<bitecs.ComponentRef, ComponentDefinition>()
/** Global id → definition registry. Components are global; multiple worlds share them. */
const componentById = new Map<string, ComponentDefinition>()

export const defineComponent = <T extends TSchema>(options: ComponentOptions<T>): ComponentDefinition<T> => {
  const { id, label = id, schema, sync = true } = options
  const existing = componentById.get(id)
  if (existing) return existing as ComponentDefinition<T>
  const { soaFields, valueFields } = classifyFields(schema)

  // Strict: SoA fields and non-SoA fields are different replication channels.
  // Mixing them in one component would silently drop the non-SoA fields on
  // the binary wire — a footgun. Force the split at definition time.
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
  const $createSoA = makeSoAStoreFactory(schema)
  const isBinary = sync && soaFields.length > 0
  const channel: ReplicationChannel = !sync ? 'local' : isBinary ? 'continuous' : 'event'

  // bitECS component ref — opaque marker object. We use a fresh object per
  // definition so multiple components have distinct refs even when their
  // schemas have no fields.
  const $ref: bitecs.ComponentRef = { __ce: id } as bitecs.ComponentRef

  const componentSchema: ComponentSchema = {
    id,
    jsonSchema: schema as object,
    shaclShape: toShaclShape(id, schema, channel),
    channel
  }

  const definition: ComponentDefinition<T> = {
    id,
    label,
    $schema: schema,
    sync,
    channel,
    isBinary,
    componentSchema,
    $defaults,
    $ref,
    $soaFields: soaFields,
    $valueFields: valueFields,
    $createSoA
  }
  componentByRef.set($ref, definition as ComponentDefinition)
  componentById.set(id, definition as ComponentDefinition)
  return definition
}

/** Resolve a ComponentDefinition from its bitECS ref. */
export const getComponentDefinition = (ref: bitecs.ComponentRef): ComponentDefinition | undefined =>
  componentByRef.get(ref)

/** Resolve a ComponentDefinition by its id (across worlds). */
export const getComponentById = (id: string): ComponentDefinition | undefined => componentById.get(id)

/** Iterate every globally-defined ComponentDefinition (shared across worlds). */
export const allComponents = (): ComponentDefinition[] => Array.from(componentById.values())

// ── Per-world storage ─────────────────────────────────────────────────────────
//
// Storage (SoA typed arrays + per-entity instance maps) MUST be per-world. Two
// worlds in the same process use the same global ComponentDefinition but their
// entity ids overlap; collapsing storage onto the definition would corrupt
// state across worlds. We lazily materialise stores per-world on first use.

const worldStores = new WeakMap<World, WeakMap<ComponentDefinition, PerWorldStores>>()

const getStores = (world: World, component: ComponentDefinition): PerWorldStores => {
  let perWorld = worldStores.get(world)
  if (!perWorld) {
    perWorld = new WeakMap()
    worldStores.set(world, perWorld)
  }
  let stores = perWorld.get(component)
  if (!stores) {
    stores = { soa: component.$createSoA(), store: {} }
    perWorld.set(component, stores)
  }
  return stores
}

const registeredWorldComponents = new WeakMap<World, Set<ComponentDefinition>>()

const ensureRegistered = (world: World, component: ComponentDefinition): void => {
  let set = registeredWorldComponents.get(world)
  if (!set) {
    set = new Set()
    registeredWorldComponents.set(world, set)
  }
  if (set.has(component)) return
  set.add(component)
  // Ensure stores exist (so callers iterating world's registered components
  // can rely on getStores returning real storage).
  getStores(world, component)
  world.network.schemas.set(component.id, component.componentSchema)
  for (const hook of componentRegisterHooks) hook(world, component)
}

const componentRegisterHooks: Array<(world: World, component: ComponentDefinition) => void> = []
export const registerComponentRegisterHook = (hook: (world: World, component: ComponentDefinition) => void): void => {
  componentRegisterHooks.push(hook)
}

/**
 * Public accessor — exposes a component's per-world SoA stores. Used by
 * snapshot serialisation, mutation pipeline runtime sampling, and any external
 * code that needs direct SoA reads (e.g. renderers).
 */
export const getSoA = (world: World, component: ComponentDefinition): Record<string, unknown> =>
  getStores(world, component).soa

/** Public accessor — per-world per-entity instance map (value-typed fields). */
export const getInstanceStore = (
  world: World,
  component: ComponentDefinition
): Record<Entity, Record<string, unknown>> => getStores(world, component).store

/** Iterate every entity that currently has the component on this world (linear scan of instance map). */
export const componentEntities = (world: World, component: ComponentDefinition): Entity[] =>
  Object.keys(getStores(world, component).store).map((k) => Number(k))

// ── set / get / remove ────────────────────────────────────────────────────────

export interface SetComponentOptions {
  /** Origin tag for the mutation pipeline. 'local' (default) is outbound; 'network' is suppressed. */
  origin?: Origin
}

const writeSoA = (
  soa: Record<string, unknown>,
  component: ComponentDefinition,
  entity: Entity,
  value: Record<string, unknown>
): void => {
  for (const field of component.$soaFields) {
    if (!(field in value)) continue
    const v = (value as Record<string, unknown>)[field]
    const store = soa[field] as
      | { from?: (entity: number, data: unknown) => void; resize?: (n: number) => void }
      | undefined
    if (!store) continue
    if (typeof store.resize === 'function') store.resize(entity + 1)
    if (typeof store.from === 'function') {
      store.from(entity, v)
    } else if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      ;(store as unknown as { [k: number]: number })[entity] =
        (v as unknown as ArrayLike<number>)[0] ?? (v as unknown as number)
    } else if (typeof v === 'number') {
      ;(store as unknown as { [k: number]: number })[entity] = v
    }
  }
}

const readSoA = (
  soa: Record<string, unknown>,
  component: ComponentDefinition,
  entity: Entity,
  into: Record<string, unknown>
): void => {
  for (const field of component.$soaFields) {
    const store = soa[field] as { to?: (entity: number, out?: unknown) => unknown } | undefined
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
  const stores = getStores(world, component as ComponentDefinition)
  const origin: Origin = options.origin ?? 'local'
  const wasPresent = bitecs.hasComponent(world, entity, component.$ref)

  if (!wasPresent) {
    bitecs.addComponent(world, entity, component.$ref)
    const merged: Record<string, unknown> = { ...component.$defaults }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) merged[k] = v
    const initialised = Value.Default(component.$schema, merged) as Record<string, unknown>
    const instance: Record<string, unknown> = {}
    for (const field of component.$valueFields) {
      if (field in initialised) instance[field] = initialised[field]
    }
    stores.store[entity] = instance
    writeSoA(stores.soa, component as ComponentDefinition, entity, initialised)
  } else {
    const instance = stores.store[entity] ?? {}
    for (const field of component.$valueFields) {
      if (field in (value as Record<string, unknown>)) {
        instance[field] = (value as Record<string, unknown>)[field]
      }
    }
    stores.store[entity] = instance
    writeSoA(stores.soa, component as ComponentDefinition, entity, value as Record<string, unknown>)
  }

  if (origin === 'local' && component.sync) {
    if (component.isBinary) {
      markRuntimeDirty(world, entity, component.id)
    } else {
      world.authoredQueue.push({
        entity,
        predicate: component.id,
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
  const stores = getStores(world, component as ComponentDefinition)
  const result: Record<string, unknown> = { ...stores.store[entity] }
  readSoA(stores.soa, component as ComponentDefinition, entity, result)
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
  const stores = getStores(world, component as ComponentDefinition)
  const origin: Origin = options.origin ?? 'local'
  bitecs.removeComponent(world, entity, component.$ref)
  delete stores.store[entity]
  if (component.isBinary) clearRuntimeDirty(world, entity, component.id)
  if (origin === 'local' && component.sync && !component.isBinary) {
    world.authoredQueue.push({
      entity,
      predicate: component.id,
      op: 'remove',
      value: null,
      origin
    })
  }
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
