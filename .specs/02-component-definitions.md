# Spec 02: Component Definitions & Lifecycle

## Project & Architecture Context

**Connection Engine** is a semantic spatial web engine — a multiplayer-first, data-driven TypeScript engine for real-time spatial experiences built on web standards.

**Core design principles:**

1. **Everything is an entity.** Users, avatars, scores, quests, factions, inventories — only engine runtime bindings live outside the ECS.
2. **Fewest abstractions.** One ECS/change model serves realtime replication, authority, validation, and persistence integrations.
3. **Component-level mutation categories.** Network behaviour is defined per-component as authored (reliable, governance-validated, event-sourced), runtime (binary, authority-checked, ephemeral), or local (never replicated).
4. **Semantic graph runtime.** The ECS is a graph of typed relationships — components are schemas, relationships are predicates, queries are pattern matching.

**Tech stack:** TypeScript, bitECS v4, TypeBox, Vitest

**Dependency chain:** This is Spec 02 (Tier 1). Depends on:

- `01-world-entity.md` — World and Entity types

Depended on by:

- `03-relations-identity.md` — uses ComponentDefinition for UIDComponent
- `04-systems-prefabs-serialization.md` — uses ComponentDefinition for prefabs and serialization
- `05-mutation-pipeline.md` — uses mutation categories and component stores
- `06-users-peers-authority.md` — uses defineComponent for UserComponent, PeerComponent
- `07-governance.md` — uses defineComponent for constraint components

---

## Scope & Intent

This spec defines the component system — how data types are declared, how data is stored and accessed on entities, and how component lifecycle events are observed. Components are the primary data-bearing primitive in Connection Engine.

Key design decisions:

- **Single `defineComponent` options-object API** — id, label, schema, mutationCategory
- **Unified Schema namespace** — TypeBox-backed, producing both SoA stores (for Vec3, Quat, etc.) and instance stores (for string, boolean, etc.)
- **Mutation category at the component level** — determines network transport path
- **ComponentSchema generation** — JSON Schema + SHACL shape automatically derived
- **bitECS observer hooks** — onAdd, onRemove, onSet, onGet with composition operators

---

## Requirements

### R1: Schema Namespace

The `Schema` namespace provides type constructors for defining component fields. It wraps TypeBox for JSON Schema generation while adding ECS-specific types that map to SoA (Structure of Arrays) storage.

```typescript
import {
  Type,
  type TSchema,
  type TObject,
  type TNumber,
  type TString,
  type TBoolean,
  type TArray,
  type TOptional
} from '@sinclair/typebox'

/**
 * Schema field classification:
 * - SoA fields: Vec3, Quat, Mat4, Float32, Float64, Int32, Uint32 — stored in typed arrays
 * - Instance fields: String, Number, Boolean, Enum, Array, Object, Optional — stored per-entity
 */

/** Marker symbol indicating a schema type maps to SoA storage. */
declare const SoA: unique symbol

/** A TypeBox schema annotated with SoA storage metadata. */
type SoASchema = TSchema & {
  [SoA]: true
  arrayType: Float32ArrayConstructor | Float64ArrayConstructor | Int32ArrayConstructor | Uint32ArrayConstructor
  fieldCount: number
}

/**
 * The unified Schema namespace for defining component fields.
 * TypeBox-backed for JSON Schema generation. ECS-specific types
 * produce SoA stores with typed arrays.
 */
declare namespace Schema {
  // ---- Instance-stored types (per-entity object storage) ----

  /** A string field. */
  function String(options?: { default?: string }): TString

  /** A number field (stored in instance store, not SoA). */
  function Number(options?: { default?: number; minimum?: number; maximum?: number }): TNumber

  /** A boolean field. */
  function Boolean(options?: { default?: boolean }): TBoolean

  /** An enum field (string union). */
  function Enum<T extends string[]>(values: [...T], options?: { default?: T[number] }): TSchema

  /** An array field (variable-length). */
  function Array<T extends TSchema>(items: T, options?: { default?: unknown[] }): TArray<T>

  /** A nested object field. */
  function Object<T extends Record<string, TSchema>>(
    properties: T,
    options?: { additionalProperties?: boolean }
  ): TObject

  /** An optional field wrapper. */
  function Optional<T extends TSchema>(schema: T): TOptional<T>

  /** A record/map field (string keys). */
  function Record<V extends TSchema>(keys: TString, values: V): TSchema

  // ---- SoA-stored types (typed array storage, indexed by entity ID) ----

  /**
   * A 3-component vector (x, y, z). Stored as 3 Float32Arrays.
   * @param options.default - Default [x, y, z] values (default: [0, 0, 0])
   */
  function Vec3(options?: { default?: [number, number, number] }): SoASchema

  /**
   * A quaternion (x, y, z, w). Stored as 4 Float32Arrays.
   * @param options.default - Default [x, y, z, w] values (default: [0, 0, 0, 1])
   */
  function Quat(options?: { default?: [number, number, number, number] }): SoASchema

  /**
   * A 4x4 matrix. Stored as 16 Float32Arrays.
   * @param options.default - Default 16-element array (default: identity matrix)
   */
  function Mat4(options?: { default?: number[] }): SoASchema

  /**
   * A single 32-bit float. Stored as 1 Float32Array.
   * @param options.default - Default value (default: 0)
   */
  function Float32(options?: { default?: number }): SoASchema

  /**
   * A single 64-bit float. Stored as 1 Float64Array.
   * @param options.default - Default value (default: 0)
   */
  function Float64(options?: { default?: number }): SoASchema

  /**
   * A single 32-bit signed integer. Stored as 1 Int32Array.
   * @param options.default - Default value (default: 0)
   */
  function Int32(options?: { default?: number }): SoASchema

  /**
   * A single 32-bit unsigned integer. Stored as 1 Uint32Array.
   * @param options.default - Default value (default: 0)
   */
  function Uint32(options?: { default?: number }): SoASchema
}
```

#### SoA Field Expansion

SoA types expand into multiple named typed arrays. For example:

| Schema Type        | Fields Generated       | Array Type     | Count |
| ------------------ | ---------------------- | -------------- | ----- |
| `Schema.Vec3()`    | `.x`, `.y`, `.z`       | `Float32Array` | 3     |
| `Schema.Quat()`    | `.x`, `.y`, `.z`, `.w` | `Float32Array` | 4     |
| `Schema.Mat4()`    | `[0]`..`[15]`          | `Float32Array` | 16    |
| `Schema.Float32()` | (direct)               | `Float32Array` | 1     |
| `Schema.Float64()` | (direct)               | `Float64Array` | 1     |
| `Schema.Int32()`   | (direct)               | `Int32Array`   | 1     |
| `Schema.Uint32()`  | (direct)               | `Uint32Array`  | 1     |

### R2: Component Definition

```typescript
/** Mutation category — how changes to this component propagate over the network. */
type MutationCategory = 'authored' | 'runtime' | 'local'

/**
 * SoA store type — typed arrays keyed by field path, indexed by entity ID.
 * For a Vec3 field 'position', this produces:
 *   position: { x: Float32Array, y: Float32Array, z: Float32Array }
 */
type SoAStore<T extends TObject> = {
  [K in keyof T['properties']]: T['properties'][K] extends SoASchema ? SoAFieldArrays<T['properties'][K]> : never
}

/** Expanded SoA field arrays for a given SoA schema type. */
type SoAFieldArrays<T extends SoASchema> =
  T extends ReturnType<typeof Schema.Vec3>
    ? { x: Float32Array; y: Float32Array; z: Float32Array }
    : T extends ReturnType<typeof Schema.Quat>
      ? { x: Float32Array; y: Float32Array; z: Float32Array; w: Float32Array }
      : T extends ReturnType<typeof Schema.Float32>
        ? Float32Array
        : T extends ReturnType<typeof Schema.Float64>
          ? Float64Array
          : T extends ReturnType<typeof Schema.Int32>
            ? Int32Array
            : T extends ReturnType<typeof Schema.Uint32>
              ? Uint32Array
              : never

/**
 * Instance store type — per-entity objects for non-SoA fields.
 * Indexed by entity ID.
 */
type InstanceStore<T extends TObject> = Map<
  Entity,
  {
    [K in InstanceKeys<T>]: Static<T['properties'][K]>
  }
>

/** Extract keys from T whose values are NOT SoA schemas. */
type InstanceKeys<T extends TObject> = {
  [K in keyof T['properties']]: T['properties'][K] extends SoASchema ? never : K
}[keyof T['properties']]

/** Extract keys from T whose values ARE SoA schemas. */
type SoAKeys<T extends TObject> = {
  [K in keyof T['properties']]: T['properties'][K] extends SoASchema ? K : never
}[keyof T['properties']]

/**
 * Options for defining a component. Passed as a single object to defineComponent().
 */
interface ComponentOptions<T extends TObject = TObject> {
  /**
   * Machine-stable identifier.
   * Used for serialisation, network protocol, SHACL URIs, and schema registry.
   * Must be unique across all components in a world.
   */
  id: string

  /** Human-readable label for tooling/debug. */
  label: string

  /**
   * The unified Schema definition. Captures field types, defaults, and validation.
   * Must be a Schema.Object(...) wrapping one or more fields.
   */
  schema: T

  /**
   * How mutations to this component propagate over the network.
   * - 'authored': reliable, governance-validated, event-sourced
   * - 'runtime': binary transport, authority-checked, ephemeral
   * - 'local': never replicated
   *
   * If omitted, derived from the schema's field types:
   * - Schema has any SoA-typed fields → 'runtime'
   * - Schema has only instance-typed fields → 'authored'
   */
  mutationCategory?: MutationCategory
}

/**
 * A registered component type. Returned by defineComponent().
 * Carries the schema, stores, and generated ComponentSchema.
 */
interface ComponentDefinition<T extends TObject = TObject> {
  /** Machine-stable identifier */
  readonly id: string

  /** Human-readable label */
  readonly label: string

  /** The unified Schema definition */
  readonly $schema: T

  /** How mutations to this component propagate */
  readonly mutationCategory: MutationCategory

  /**
   * SoA stores for SoA-typed fields.
   * Typed arrays indexed by entity ID.
   * Empty object if schema has no SoA fields.
   */
  readonly $soaStore: SoAStore<T>

  /**
   * Per-entity instance store for value-typed fields.
   * Map<Entity, instance data>.
   * Empty Map if schema has no instance fields.
   */
  readonly $store: InstanceStore<T>

  /**
   * Generated SHACL shape with action semantics — the ComponentSchema.
   * Used for validation, replication metadata, governance hooks, and tooling.
   */
  readonly componentSchema: ComponentSchema

  /**
   * bitECS component reference (internal).
   * Used for query matching and bitECS integration.
   */
  readonly $bitECS: unknown
}

/** Shareable schema metadata produced from a component definition. */
interface ComponentSchema {
  /** JSON Schema generated from the TypeBox schema */
  readonly jsonSchema: object
  /** SHACL shape for validation (maps TypeBox to RDF/SHACL) */
  readonly shaclShape: object
  /** How mutations propagate */
  readonly mutationCategory: MutationCategory
}
```

### R3: defineComponent Function

```typescript
/**
 * Define a new component type.
 *
 * 1. Validates the options (unique id, valid schema)
 * 2. Determines mutation category (explicit or derived from schema)
 * 3. Creates bitECS component for query matching
 * 4. Generates SoA stores for SoA-typed fields
 * 5. Initialises instance store (empty Map)
 * 6. Generates ComponentSchema (JSON Schema + SHACL shape)
 * 7. Returns a frozen ComponentDefinition
 *
 * @param options - Component definition options
 * @returns A ComponentDefinition ready for use with setComponent/getComponent/removeComponent
 * @throws Error if id is already registered
 *
 * @example
 * const Transform = defineComponent({
 *   id: 'Transform',
 *   label: 'Transform',
 *   mutationCategory: 'runtime',
 *   schema: Schema.Object({
 *     position: Schema.Vec3(),
 *     rotation: Schema.Quat(),
 *     scale: Schema.Vec3({ default: [1, 1, 1] }),
 *   }),
 * })
 *
 * @example
 * const Health = defineComponent({
 *   id: 'Health',
 *   label: 'Health',
 *   // mutationCategory defaults to 'authored' (value-only schema)
 *   schema: Schema.Object({
 *     current: Schema.Number({ default: 100 }),
 *     max: Schema.Number({ default: 100 }),
 *   }),
 * })
 */
declare function defineComponent<T extends TObject>(options: ComponentOptions<T>): ComponentDefinition<T>
```

#### Mutation Category Derivation Pseudocode

```
function deriveMutationCategory(schema: TObject): MutationCategory:
  if any field in schema.properties is SoASchema (has [SoA] marker):
    return 'runtime'
  else:
    return 'authored'
```

#### ComponentSchema Generation Pseudocode

```
function generateComponentSchema(id, schema, mutationCategory):
  // JSON Schema — TypeBox generates this natively
  jsonSchema = TypeBox.JsonSchema(schema)
  jsonSchema.title = id

  // SHACL shape — map TypeBox schema to SHACL NodeShape
  shaclShape = {
    '@id': `ce://${id}Shape`,
    '@type': 'sh:NodeShape',
    'sh:targetClass': `ce://${id}`,
    'sh:property': mapFieldsToSHACL(schema)
  }

  return { jsonSchema, shaclShape, mutationCategory }
```

### R4: setComponent

Adds a component to an entity (if not present) or updates existing component data (partial merge).

```typescript
/**
 * Instance data type for a component — the writable shape of its non-SoA fields,
 * plus SoA fields expressed as value arrays for convenience.
 */
type ComponentData<T extends TObject> = Partial<{
  [K in keyof T['properties']]: T['properties'][K] extends SoASchema
    ? T['properties'][K] extends ReturnType<typeof Schema.Vec3>
      ? [number, number, number]
      : T['properties'][K] extends ReturnType<typeof Schema.Quat>
        ? [number, number, number, number]
        : number
    : Static<T['properties'][K]>
}>

/**
 * Add or update a component on an entity.
 *
 * **If the component is NOT on the entity (add):**
 * 1. Call bitECS addComponent (triggers onAdd observers)
 * 2. Create instance data by merging: schema defaults → provided values
 * 3. Write SoA fields from instance data → SoA stores
 * 4. Store instance data in $store[entity]
 * 5. If authored: queue structured mutation for end-of-tick batch (Spec 05)
 * 6. If runtime: set dirty flag (Spec 05)
 *
 * **If the component IS on the entity (update):**
 * 1. Partial shallow merge of provided fields into existing instance data
 * 2. Sync SoA fields if any SoA fields were changed
 * 3. Trigger onSet observers with the new values
 * 4. If authored: queue structured mutation
 * 5. If runtime: set dirty flag
 *
 * @param world - The world
 * @param entity - The entity to add/update the component on
 * @param component - The ComponentDefinition
 * @param data - Partial data to set (merged with defaults on add, merged with existing on update)
 *
 * @example
 * // Add Transform with specific position
 * setComponent(world, entity, Transform, {
 *   position: [10, 0, 5],
 *   rotation: [0, 0, 0, 1],
 *   scale: [1, 1, 1],
 * })
 *
 * // Update only position (other fields unchanged)
 * setComponent(world, entity, Transform, { position: [20, 0, 5] })
 */
declare function setComponent<T extends TObject>(
  world: World,
  entity: Entity,
  component: ComponentDefinition<T>,
  data?: ComponentData<T>
): void
```

#### Pseudocode

```
function setComponent(world, entity, component, data?):
  isNew = !hasComponent(world, entity, component)

  if isNew:
    bitecs.addComponent(world, entity, component.$bitECS)
    // Build instance from defaults + data
    instance = applyDefaults(component.$schema)
    if data:
      shallowMerge(instance, data)
    // Write SoA fields
    for each soaField in getSoAFields(component.$schema):
      writeSoAField(component.$soaStore, entity, soaField, instance[soaField])
    // Store instance data
    component.$store.set(entity, filterInstanceFields(instance, component.$schema))

  else:
    if data:
      existing = component.$store.get(entity)
      shallowMerge(existing, filterInstanceFields(data, component.$schema))
      // Sync SoA fields that were in data
      for each soaField in getSoAFields(component.$schema):
        if soaField in data:
          writeSoAField(component.$soaStore, entity, soaField, data[soaField])
    // Trigger onSet observers (handled by bitECS set() call)
```

#### SoA ↔ Instance Sync

When `setComponent` is called with data that includes SoA fields (like `position: [10, 0, 5]`):

1. The array values are unpacked into the SoA typed arrays: `component.$soaStore.position.x[entity] = 10`, etc.
2. The instance store does NOT duplicate SoA data — SoA fields are read from typed arrays, not the instance store.

### R5: getComponent

```typescript
/**
 * Get component data for an entity.
 *
 * Returns a read-only view of the component's instance data.
 * SoA fields are read from typed arrays and assembled into the return value.
 * Triggers onGet observers if registered.
 *
 * @param world - The world
 * @param entity - The entity
 * @param component - The ComponentDefinition
 * @returns The component data, or undefined if the entity doesn't have this component
 *
 * @example
 * const health = getComponent(world, entity, Health)
 * if (health) {
 *   console.log(health.current, health.max)
 * }
 */
declare function getComponent<T extends TObject>(
  world: World,
  entity: Entity,
  component: ComponentDefinition<T>
): Readonly<ComponentData<T>> | undefined
```

#### Pseudocode

```
function getComponent(world, entity, component):
  if !hasComponent(world, entity, component):
    return undefined

  result = {}

  // Read instance fields
  instanceData = component.$store.get(entity)
  if instanceData:
    Object.assign(result, instanceData)

  // Read SoA fields — assemble from typed arrays
  for each soaField in getSoAFields(component.$schema):
    result[soaField] = readSoAField(component.$soaStore, entity, soaField)

  // Trigger onGet observers
  // (bitECS handles this if get observers are registered)

  return Object.freeze(result)
```

### R6: removeComponent

```typescript
/**
 * Remove a component from an entity.
 *
 * 1. Trigger onRemove observers
 * 2. If authored: queue removal mutation for end-of-tick batch (Spec 05)
 * 3. If runtime: mark entity as removed from binary transport (Spec 05)
 * 4. Zero out SoA stores for this entity
 * 5. Delete entry from $store
 * 6. Call bitECS removeComponent
 *
 * @param world - The world
 * @param entity - The entity
 * @param component - The ComponentDefinition to remove
 * @throws If entity does not have this component (or silently no-ops — implementation choice)
 */
declare function removeComponent<T extends TObject>(
  world: World,
  entity: Entity,
  component: ComponentDefinition<T>
): void
```

### R7: hasComponent

```typescript
/**
 * Check if an entity has a specific component.
 *
 * Wraps bitECS hasComponent.
 *
 * @param world - The world
 * @param entity - The entity
 * @param component - The ComponentDefinition
 * @returns true if the entity has this component
 */
declare function hasComponent<T extends TObject>(
  world: World,
  entity: Entity,
  component: ComponentDefinition<T>
): boolean
```

### R8: Observers

Observers are immediately invoked hooks that fire synchronously on component mutation. They use bitECS's `observe` API. Connection Engine re-exports these and ensures they work with `ComponentDefinition` wrappers.

```typescript
import { observe, onAdd, onRemove, onSet, onGet, Or, Not, And, Any, All, None, Wildcard } from 'bitecs'

/**
 * Register an observer that fires when entities match the given terms.
 *
 * @param world - The world to observe
 * @param hook - The observer hook (onAdd, onRemove, onSet, onGet applied to components/relations)
 * @param callback - Function to invoke when the condition is met
 * @returns An unsubscribe function
 *
 * @example
 * // Fire when entity gains both Transform and Health
 * const unsub = observe(world, onAdd(Transform, Health), (entity) => {
 *   console.log('Entity', entity, 'has both Transform and Health')
 * })
 *
 * // Fire when entity loses Health
 * observe(world, onRemove(Health), (entity) => {
 *   console.log('Entity', entity, 'lost Health')
 * })
 *
 * // Fire when Health data is set
 * observe(world, onSet(Health), (entity, data) => {
 *   console.log('Health set on', entity, data)
 * })
 *
 * // Compose with operators
 * observe(world, onAdd(Or(DamageSource, HealSource)), (entity) => {
 *   console.log('Entity gained DamageSource or HealSource')
 * })
 *
 * // Negation
 * observe(world, onAdd(Transform, Not(Static)), (entity) => {
 *   console.log('Dynamic entity with Transform')
 * })
 */
```

#### Observer Types

| Hook | Fires When | Callback Signature |
| --- | --- | --- |
| `onAdd(...components)` | Entity gains all specified components (enters query match) | `(entity: Entity) => void` |
| `onRemove(...components)` | Entity loses any specified component (exits query match) | `(entity: Entity) => void` |
| `onSet(component)` | Component data is written via `setComponent` | `(entity: Entity, data: ComponentData) => void` |
| `onGet(component)` | Component data is read via `getComponent` | `(entity: Entity) => ComponentData` |

#### Composition Operators

| Operator    | Meaning                                                     |
| ----------- | ----------------------------------------------------------- |
| `Or(A, B)`  | Match if entity has A OR B                                  |
| `Not(A)`    | Match if entity does NOT have A                             |
| `And(A, B)` | Match if entity has A AND B (default when passing multiple) |
| `Any`       | Match any component (wildcard)                              |
| `All`       | Alias for And                                               |
| `None`      | Alias for Not                                               |
| `Wildcard`  | Used in relationship queries — match any target             |

### R9: Direct SoA Access

For hot-path code (systems that run every tick), SoA stores can be accessed directly without going through `getComponent`/`setComponent`. This is the performance-critical path.

```typescript
/**
 * Direct SoA access pattern — for systems that need maximum performance.
 *
 * @example
 * // In a physics system (hot path):
 * const entities = query(world, [Transform, Velocity])
 * for (const entity of entities) {
 *   Transform.$soaStore.position.x[entity] += Velocity.$soaStore.linear.x[entity] * dt
 *   Transform.$soaStore.position.y[entity] += Velocity.$soaStore.linear.y[entity] * dt
 *   Transform.$soaStore.position.z[entity] += Velocity.$soaStore.linear.z[entity] * dt
 * }
 *
 * // This bypasses observers and instance stores — pure typed array access.
 * // For runtime-category components, the binary transport picks up changes
 * // via dirty flags (Spec 05).
 */
```

---

## Test Specifications

### defineComponent Tests

```typescript
import { describe, it, expect } from 'vitest'
import { defineComponent, Schema } from '../src/component'
import type { ComponentDefinition, MutationCategory } from '../src/component'

describe('defineComponent', () => {
  it('should create a component with all required fields', () => {
    const Health = defineComponent({
      id: 'Health',
      label: 'Health',
      schema: Schema.Object({
        current: Schema.Number({ default: 100 }),
        max: Schema.Number({ default: 100 })
      })
    })

    expect(Health.id).toBe('Health')
    expect(Health.label).toBe('Health')
    expect(Health.$schema).toBeDefined()
    expect(Health.mutationCategory).toBe('authored') // default: no SoA fields
    expect(Health.componentSchema).toBeDefined()
    expect(Health.componentSchema.jsonSchema).toBeDefined()
    expect(Health.componentSchema.shaclShape).toBeDefined()
  })

  it('should default to runtime mutation category when schema has SoA fields', () => {
    const Transform = defineComponent({
      id: 'Transform',
      label: 'Transform',
      schema: Schema.Object({
        position: Schema.Vec3(),
        rotation: Schema.Quat(),
        scale: Schema.Vec3({ default: [1, 1, 1] })
      })
    })

    expect(Transform.mutationCategory).toBe('runtime')
  })

  it('should default to authored mutation category when schema has only instance fields', () => {
    const Inventory = defineComponent({
      id: 'Inventory',
      label: 'Inventory',
      schema: Schema.Object({
        slots: Schema.Number({ default: 10 }),
        name: Schema.String({ default: '' })
      })
    })

    expect(Inventory.mutationCategory).toBe('authored')
  })

  it('should respect explicit mutation category override', () => {
    const SpawnPoint = defineComponent({
      id: 'SpawnPoint',
      label: 'Spawn Point',
      mutationCategory: 'authored', // explicit: even though it has Vec3
      schema: Schema.Object({
        position: Schema.Vec3(),
        radius: Schema.Number({ default: 1.0 })
      })
    })

    expect(SpawnPoint.mutationCategory).toBe('authored')
  })

  it('should support local mutation category', () => {
    const DebugInfo = defineComponent({
      id: 'DebugInfo',
      label: 'Debug Info',
      mutationCategory: 'local',
      schema: Schema.Object({
        label: Schema.String({ default: '' }),
        wireframe: Schema.Boolean({ default: false })
      })
    })

    expect(DebugInfo.mutationCategory).toBe('local')
  })

  it('should create SoA stores for SoA-typed fields', () => {
    const Transform = defineComponent({
      id: 'TransformSoA',
      label: 'Transform',
      schema: Schema.Object({
        position: Schema.Vec3(),
        rotation: Schema.Quat()
      })
    })

    // SoA stores should have typed arrays
    expect(Transform.$soaStore.position.x).toBeInstanceOf(Float32Array)
    expect(Transform.$soaStore.position.y).toBeInstanceOf(Float32Array)
    expect(Transform.$soaStore.position.z).toBeInstanceOf(Float32Array)
    expect(Transform.$soaStore.rotation.x).toBeInstanceOf(Float32Array)
    expect(Transform.$soaStore.rotation.y).toBeInstanceOf(Float32Array)
    expect(Transform.$soaStore.rotation.z).toBeInstanceOf(Float32Array)
    expect(Transform.$soaStore.rotation.w).toBeInstanceOf(Float32Array)
  })

  it('should initialise instance store as empty Map', () => {
    const Health = defineComponent({
      id: 'HealthStore',
      label: 'Health',
      schema: Schema.Object({
        current: Schema.Number({ default: 100 }),
        max: Schema.Number({ default: 100 })
      })
    })

    expect(Health.$store).toBeInstanceOf(Map)
    expect(Health.$store.size).toBe(0)
  })

  it('should generate a ComponentSchema with JSON Schema', () => {
    const Health = defineComponent({
      id: 'HealthSchema',
      label: 'Health',
      schema: Schema.Object({
        current: Schema.Number({ default: 100 }),
        max: Schema.Number({ default: 100 })
      })
    })

    const { jsonSchema } = Health.componentSchema
    expect(jsonSchema).toHaveProperty('type', 'object')
    expect(jsonSchema).toHaveProperty('properties')
    expect((jsonSchema as any).properties).toHaveProperty('current')
    expect((jsonSchema as any).properties).toHaveProperty('max')
  })

  it('should generate a ComponentSchema with SHACL shape', () => {
    const Health = defineComponent({
      id: 'HealthSHACL',
      label: 'Health',
      schema: Schema.Object({
        current: Schema.Number({ default: 100 }),
        max: Schema.Number({ default: 100 })
      })
    })

    const { shaclShape } = Health.componentSchema
    expect(shaclShape).toHaveProperty('@type', 'sh:NodeShape')
    expect(shaclShape).toHaveProperty('sh:property')
  })

  it('should throw on duplicate component id', () => {
    defineComponent({
      id: 'UniqueTest',
      label: 'Unique Test',
      schema: Schema.Object({ value: Schema.Number() })
    })

    expect(() =>
      defineComponent({
        id: 'UniqueTest',
        label: 'Unique Test 2',
        schema: Schema.Object({ value: Schema.Number() })
      })
    ).toThrow()
  })

  it('should support hybrid schemas with both SoA and instance fields', () => {
    const Avatar = defineComponent({
      id: 'Avatar',
      label: 'Avatar',
      schema: Schema.Object({
        position: Schema.Vec3(), // SoA
        displayName: Schema.String(), // instance
        health: Schema.Number({ default: 100 }) // instance
      })
    })

    // Should have SoA store for position
    expect(Avatar.$soaStore.position.x).toBeInstanceOf(Float32Array)
    // Should have instance store for string/number fields
    expect(Avatar.$store).toBeInstanceOf(Map)
    // Defaults to runtime because it has SoA fields
    expect(Avatar.mutationCategory).toBe('runtime')
  })
})
```

### setComponent Tests

```typescript
import { createWorld, destroyWorld } from '../src/world'
import { createEntity } from '../src/entity'
import { defineComponent, setComponent, getComponent, hasComponent, removeComponent, Schema } from '../src/component'

describe('setComponent', () => {
  const Health = defineComponent({
    id: 'HealthSet',
    label: 'Health',
    schema: Schema.Object({
      current: Schema.Number({ default: 100 }),
      max: Schema.Number({ default: 100 })
    })
  })

  it('should add a component with default values', () => {
    const world = createWorld()
    const entity = createEntity(world)

    setComponent(world, entity, Health)

    expect(hasComponent(world, entity, Health)).toBe(true)
    const data = getComponent(world, entity, Health)
    expect(data).toBeDefined()
    expect(data!.current).toBe(100)
    expect(data!.max).toBe(100)

    destroyWorld(world)
  })

  it('should add a component with provided values overriding defaults', () => {
    const world = createWorld()
    const entity = createEntity(world)

    setComponent(world, entity, Health, { current: 50 })

    const data = getComponent(world, entity, Health)
    expect(data!.current).toBe(50)
    expect(data!.max).toBe(100) // default preserved

    destroyWorld(world)
  })

  it('should update existing component with partial merge', () => {
    const world = createWorld()
    const entity = createEntity(world)

    setComponent(world, entity, Health, { current: 100, max: 100 })
    setComponent(world, entity, Health, { current: 75 })

    const data = getComponent(world, entity, Health)
    expect(data!.current).toBe(75)
    expect(data!.max).toBe(100) // unchanged

    destroyWorld(world)
  })

  it('should write SoA fields to typed arrays', () => {
    const Transform = defineComponent({
      id: 'TransformSetTest',
      label: 'Transform',
      schema: Schema.Object({
        position: Schema.Vec3()
      })
    })

    const world = createWorld()
    const entity = createEntity(world)

    setComponent(world, entity, Transform, { position: [10, 20, 30] })

    // Direct SoA access
    expect(Transform.$soaStore.position.x[entity]).toBeCloseTo(10)
    expect(Transform.$soaStore.position.y[entity]).toBeCloseTo(20)
    expect(Transform.$soaStore.position.z[entity]).toBeCloseTo(30)

    destroyWorld(world)
  })

  it('should sync SoA fields on update', () => {
    const Transform = defineComponent({
      id: 'TransformSyncTest',
      label: 'Transform',
      schema: Schema.Object({
        position: Schema.Vec3()
      })
    })

    const world = createWorld()
    const entity = createEntity(world)

    setComponent(world, entity, Transform, { position: [10, 20, 30] })
    setComponent(world, entity, Transform, { position: [99, 88, 77] })

    expect(Transform.$soaStore.position.x[entity]).toBeCloseTo(99)
    expect(Transform.$soaStore.position.y[entity]).toBeCloseTo(88)
    expect(Transform.$soaStore.position.z[entity]).toBeCloseTo(77)

    destroyWorld(world)
  })
})
```

### getComponent Tests

```typescript
describe('getComponent', () => {
  const Health = defineComponent({
    id: 'HealthGet',
    label: 'Health',
    schema: Schema.Object({
      current: Schema.Number({ default: 100 }),
      max: Schema.Number({ default: 100 })
    })
  })

  it('should return undefined for entities without the component', () => {
    const world = createWorld()
    const entity = createEntity(world)

    const data = getComponent(world, entity, Health)
    expect(data).toBeUndefined()

    destroyWorld(world)
  })

  it('should return component data for entities with the component', () => {
    const world = createWorld()
    const entity = createEntity(world)
    setComponent(world, entity, Health, { current: 80, max: 100 })

    const data = getComponent(world, entity, Health)
    expect(data).toBeDefined()
    expect(data!.current).toBe(80)
    expect(data!.max).toBe(100)

    destroyWorld(world)
  })

  it('should include SoA fields assembled from typed arrays', () => {
    const Transform = defineComponent({
      id: 'TransformGetTest',
      label: 'Transform',
      schema: Schema.Object({
        position: Schema.Vec3()
      })
    })

    const world = createWorld()
    const entity = createEntity(world)
    setComponent(world, entity, Transform, { position: [5, 10, 15] })

    const data = getComponent(world, entity, Transform)
    expect(data).toBeDefined()
    expect(data!.position).toEqual([5, 10, 15])

    destroyWorld(world)
  })
})
```

### removeComponent Tests

```typescript
describe('removeComponent', () => {
  const Health = defineComponent({
    id: 'HealthRemove',
    label: 'Health',
    schema: Schema.Object({
      current: Schema.Number({ default: 100 }),
      max: Schema.Number({ default: 100 })
    })
  })

  it('should remove a component from an entity', () => {
    const world = createWorld()
    const entity = createEntity(world)
    setComponent(world, entity, Health, { current: 100, max: 100 })

    expect(hasComponent(world, entity, Health)).toBe(true)

    removeComponent(world, entity, Health)

    expect(hasComponent(world, entity, Health)).toBe(false)
    expect(getComponent(world, entity, Health)).toBeUndefined()

    destroyWorld(world)
  })

  it('should clean up instance store on removal', () => {
    const world = createWorld()
    const entity = createEntity(world)
    setComponent(world, entity, Health, { current: 100, max: 100 })

    removeComponent(world, entity, Health)

    expect(Health.$store.has(entity)).toBe(false)

    destroyWorld(world)
  })

  it('should zero out SoA stores on removal', () => {
    const Transform = defineComponent({
      id: 'TransformRemoveTest',
      label: 'Transform',
      schema: Schema.Object({
        position: Schema.Vec3()
      })
    })

    const world = createWorld()
    const entity = createEntity(world)
    setComponent(world, entity, Transform, { position: [10, 20, 30] })

    removeComponent(world, entity, Transform)

    expect(Transform.$soaStore.position.x[entity]).toBe(0)
    expect(Transform.$soaStore.position.y[entity]).toBe(0)
    expect(Transform.$soaStore.position.z[entity]).toBe(0)

    destroyWorld(world)
  })
})
```

### Observer Tests

```typescript
import { observe, onAdd, onRemove, onSet, Or, Not } from '../src/observers'

describe('Observers', () => {
  const Health = defineComponent({
    id: 'HealthObs',
    label: 'Health',
    schema: Schema.Object({
      current: Schema.Number({ default: 100 }),
      max: Schema.Number({ default: 100 })
    })
  })

  const Transform = defineComponent({
    id: 'TransformObs',
    label: 'Transform',
    schema: Schema.Object({
      position: Schema.Vec3()
    })
  })

  it('should fire onAdd when component is added', () => {
    const world = createWorld()
    const added: Entity[] = []

    observe(world, onAdd(Health), (entity) => {
      added.push(entity)
    })

    const entity = createEntity(world)
    setComponent(world, entity, Health)

    expect(added).toContain(entity)

    destroyWorld(world)
  })

  it('should fire onRemove when component is removed', () => {
    const world = createWorld()
    const removed: Entity[] = []

    observe(world, onRemove(Health), (entity) => {
      removed.push(entity)
    })

    const entity = createEntity(world)
    setComponent(world, entity, Health)
    removeComponent(world, entity, Health)

    expect(removed).toContain(entity)

    destroyWorld(world)
  })

  it('should fire onSet when component data is written', () => {
    const world = createWorld()
    const sets: Array<{ entity: Entity; data: any }> = []

    observe(world, onSet(Health), (entity, data) => {
      sets.push({ entity, data })
    })

    const entity = createEntity(world)
    setComponent(world, entity, Health, { current: 50 })

    expect(sets.length).toBeGreaterThan(0)
    expect(sets[0].entity).toBe(entity)

    destroyWorld(world)
  })

  it('should support Or composition', () => {
    const world = createWorld()
    const matched: Entity[] = []

    observe(world, onAdd(Or(Health, Transform)), (entity) => {
      matched.push(entity)
    })

    const entity = createEntity(world)
    setComponent(world, entity, Health)

    expect(matched).toContain(entity)

    destroyWorld(world)
  })

  it('should support Not composition', () => {
    const world = createWorld()
    const matched: Entity[] = []

    const Static = defineComponent({
      id: 'StaticObs',
      label: 'Static',
      schema: Schema.Object({})
    })

    observe(world, onAdd(Transform, Not(Static)), (entity) => {
      matched.push(entity)
    })

    const e1 = createEntity(world)
    setComponent(world, e1, Transform) // dynamic — should match

    const e2 = createEntity(world)
    setComponent(world, e2, Transform)
    setComponent(world, e2, Static) // static — should NOT match

    expect(matched).toContain(e1)
    // e2 should not be in matched (or should have been removed via exit)

    destroyWorld(world)
  })

  it('should return an unsubscribe function', () => {
    const world = createWorld()
    const added: Entity[] = []

    const unsub = observe(world, onAdd(Health), (entity) => {
      added.push(entity)
    })

    const e1 = createEntity(world)
    setComponent(world, e1, Health)
    expect(added).toContain(e1)

    unsub()

    const e2 = createEntity(world)
    setComponent(world, e2, Health)
    expect(added).not.toContain(e2)

    destroyWorld(world)
  })
})
```

---

## Edge Cases & Constraints

1. **Component IDs must be globally unique.** `defineComponent` with a duplicate `id` must throw. IDs are used in serialization, network protocol, and schema registry.

2. **SoA array sizing.** SoA typed arrays must be large enough to index by any valid entity ID. bitECS manages entity ID allocation — the arrays should match bitECS's internal sizing (typically pre-allocated to a max entity count). Array resizing strategy should match bitECS.

3. **setComponent on a destroyed entity.** Behaviour is undefined. Implementations should either throw or silently no-op.

4. **Partial merge is shallow.** `setComponent` with partial data performs a shallow merge — nested objects are replaced, not deep-merged. This is intentional for predictability.

5. **Observer firing order.** When `setComponent` adds a new component, `onAdd` fires before `onSet`. When removing, `onRemove` fires while the component data is still accessible on the entity (so observers can read it).

6. **SoA stores persist across entity removal/re-addition.** SoA typed arrays are zeroed on `removeComponent` but the memory isn't freed (it's a fixed-size array). When an entity ID is recycled and a component is re-added, the array slot is reused.

7. **ComponentSchema is immutable.** Once a component is defined, its schema, mutation category, and generated ComponentSchema cannot change.

8. **Thread safety.** Direct SoA array access in workers via SharedArrayBuffer is a concern for the systems layer (Spec 04). This spec does not address concurrent access — it defines single-threaded semantics.

---

## Dependencies

- **Spec 01 (`01-world-entity.md`)**: World, Entity types
- **bitECS v4**: `addComponent`, `removeComponent`, `hasComponent`, `observe`, `onAdd`, `onRemove`, `onSet`, `onGet`, `Or`, `Not`, `And`, `Wildcard`
- **TypeBox** (`@sinclair/typebox`): `Type`, `TObject`, `Static`, JSON Schema generation
