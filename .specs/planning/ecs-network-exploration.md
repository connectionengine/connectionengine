# Connection Engine - ECS & Network Exploration

> **Scope:** ECS runtime + realtime networking foundation. This document covers the core ECS model, realtime replication/transport, identity, authority, and governance hooks needed by higher layers. Low-frequency save/load of spatial data and user data is intentionally out of scope here, and spatial concerns such as transforms, WebXR, zones, and bounding trees are deferred to the spatial layer. This document defines the full dimensionality of the scoped area, constructs a DAG ontology of all items and relationships, describes each item with interfaces and pseudocode, and will feed into specification cases → unit tests → implementation.

## Design Principles

1. **Everything is an entity.** Users, avatars, scores, quests, factions, inventories. Only engine runtime bindings (timer, WebXR, WebGPU, resource loaders, input) live outside the ECS.
2. **Fewest abstractions.** One ECS/change model should serve realtime replication, authority, validation, and higher-layer persistence integrations - not a tangle of separate bespoke systems.
3. **The ECS is a semantic graph-shaped runtime.** Components are **ComponentSchemas** (SHACL shapes with action semantics). Relationships are predicates (typed, queryable links between entities). Queries are pattern matching over a graph of typed relationships - structurally identical to SPARQL over RDF, optimised for real-time. Mutations are categorised by intent - **authored** (deliberate, governance-validated, event-sourced) vs **runtime** (continuous, authority-checked, ephemeral) - and each category has its own transport path. Low-frequency persistence and save/load can map onto the same semantics later, but are out of scope for this layer.
4. **Semantic triples.** ECS data as `<entity, component:type, component:values>`. Relationships as `<entity, relation:type, target>`. When signed by a DID identity, they become `SignedTriple`s - mutations with cryptographic provenance (DID author + timestamp + Ed25519 proof).

---

## 0. Scope Boundary

This document defines the ECS runtime and realtime networking foundation. It intentionally does **not** define standalone interfaces for persistence graphs, sync backends, governance engines, or identity providers; those are adjacent-layer integration concerns, not the API surface of this foundational layer.

Within this scope:

- entity/component/relation lifecycle
- authored vs runtime mutation categories and their transport paths
- peers, ownership, authority, validation, and snapshots needed for live multiplayer
- the authored event log as the canonical state history

Outside this scope:

- low-frequency save/load of spatial data and user data
- persistence backends and authoring storage
- spatial foundations such as transforms-as-spatial-semantic systems, WebXR spaces, zones, and bounding trees

```typescript
/** Shareable schema metadata produced from a component definition. */
interface ComponentSchema {
  readonly jsonSchema: object // JSON Schema (from Schema definitions)
  readonly shaclShape: object // SHACL shape for validation
  readonly mutationCategory: 'authored' | 'runtime' | 'local' // how mutations propagate
}
```

---

## 1. Dimensionality

The dimensions of the ECS + Network scope - each is an axis of variability the design must handle.

### ECS Dimensions

| Dimension | Description |
| --- | --- |
| **Entity Lifecycle** | Creation, destruction, UID assignment, entity-to-entity references |
| **Component Schema** | Unified `Schema` definitions (plain + ECS-specific), SoA vs instance storage, defaults, validation |
| **Component Lifecycle** | Add, update (partial merge), remove, observers (onAdd/onRemove/onSet/onGet via bitECS) |
| **Component Mutation Category** | Per-component: authored (governance-validated, event-sourced), runtime (authority-checked, ephemeral), local-only |
| **Relationships** | Pairs, wildcards, exclusive, autoRemoveSubject, withStore, IsA |
| **Queries** | Component matching, relationship matching, wildcard, enter/exit |
| **Systems** | Phase ordering, execution context (main/worker/server), dependencies |
| **World** | Multiple isolated worlds, world lifecycle, world-level state |
| **Serialization** | Component ↔ JSON, SoA ↔ buffer, snapshot (full world), delta |
| **Layers** | Runtime ECS/realtime transport vs higher-layer persistence and spatial scopes |

### Network Dimensions

| Dimension | Description |
| --- | --- |
| **Realtime Transport** | Live replication between peers - reliable reactive events + high-frequency binary streams |
| **Connection Topology** | Client-server and peer-to-peer topologies using the same ownership/authority model |
| **Peer Identity** | Peer ID (engine instance), User (person). One user has many peers (devices/tabs). Local ↔ network UID mapping |
| **Ownership** | Which user created/owns an entity (relationship, not transferable) |
| **Authority** | Which peer has write authority (relationship, transferable between peers/users) |
| **Replication Scope** | Higher layers decide which entities are relevant to which peers; this layer supplies the replication primitives |
| **Sync Configuration** | Per-component: authored (reliable, governance-validated) vs runtime (binary, authority-checked) vs local |
| **Snapshots** | Point-in-time serialization for late join, rollback, and bootstrap |
| **Permissions** | Per-world, per-scene, per-entity action validation (governance at the replication layer) |
| **Media Channels** | Voice/video alongside data on the same peer connections |

---

## 2. DAG Ontology

All items and their relationships, scoped to ECS + Network.

```
World ──creates──▶ Entity
World ──registers──▶ ComponentDefinition
World ──registers──▶ RelationDefinition
World ──schedules──▶ System
World ──has many──▶ Connection

Entity ──has──▶ UIDComponent (unique per BelongsTo parent)
Entity ──BelongsTo──▶ Entity (identity/identity context, exclusive)
Entity ──has many──▶ ComponentInstance
Entity ──has many──▶ RelationshipPair

ComponentDefinition ──IS──▶ ComponentSchema (SHACL shape with action semantics)
ComponentDefinition ──has──▶ Schema definition
ComponentDefinition ──has──▶ MutationCategory (authored | runtime | local)
ComponentDefinition ──has──▶ StorageType (SoA | instance | hybrid)
ComponentDefinition ──produces──▶ ComponentInstance

ComponentInstance ──attached to──▶ Entity
ComponentInstance ──writes to──▶ SoAStore (if SoA fields exist)
ComponentInstance ──writes to──▶ InstanceStore (if non-SoA fields exist)
ComponentInstance ──replicates via──▶ Connection (if networked)

RelationDefinition ──has──▶ Modifiers (exclusive, autoRemoveSubject, withStore)
RelationDefinition ──produces──▶ RelationshipPair

RelationshipPair ──links──▶ Entity (subject)
RelationshipPair ──links──▶ Entity (target)
RelationshipPair ──may have──▶ RelationStore (data on the pair)
RelationshipPair ──replicates via──▶ Connection (if networked)

Schema ──defines──▶ Fields
Field ──has──▶ DataType (number, string, boolean, Schema.Vec3, Schema.Quat, etc.)
Field ──has──▶ Default

Query ──matches on──▶ ComponentDefinition
Query ──matches on──▶ RelationshipPair (including wildcards)
Query ──produces──▶ EntitySet
Query ──has──▶ EnterCallback
Query ──has──▶ ExitCallback

System ──belongs to──▶ Phase (Input | Simulation | Animation | Render)
System ──has──▶ ExecutionContext (main | worker | server)
System ──reads/writes──▶ Query
System ──ordered by──▶ System (before/after)

Phase ──ordered──▶ Phase (Input → Simulation → Animation → Render)

Connection ──links──▶ Peer (entity)
Connection ──carries──▶ Realtime transport payloads
Peer (entity) ──has──▶ PeerComponent (peerId, latency)
Peer (entity) ──BelongsTo──▶ User (entity)
User (entity) ──has many──▶ Peer (one user, many engine instances/devices/tabs)

Snapshot ──captures──▶ World (full or partial)
Snapshot ──used for──▶ Late join, rollback, recording

Permissions ──validates──▶ incoming replicated mutations
Permissions ──scoped to──▶ World | Scene | Entity (hierarchy-inherited)

Spatial partitioning, zones, WebXR spaces, and bounding trees
  ──belong to──▶ Spatial layer (next scope)
Persistence / save-load of spatial data and user data
  ──belong to──▶ Higher-level data / authoring scopes (out of scope here)
```

---

## 3. Item Descriptions, Interfaces & Pseudocode

### 3.1 World

The top-level container for all ECS state. Holds entities, component/relation registries, systems, connection state, and schema metadata. Multiple worlds can exist independently (e.g., lobby world + game world). Objects/actors can exist across multiple worlds as **separate entities** - different worlds mean different entity IDs and runtime state. An actor in two worlds = two entities, one per world.

```typescript
// --- Design-level interfaces. Not final implementations. ---

import type { World as BitECSWorld } from 'bitecs'

/** Realtime bindings - how the world tracks live peer replication state. */
interface RealtimeBindings {
  /** Active peer connections for this world/session */
  connections: Set<Connection>
  /** Schema registry - component name → generated ComponentSchema */
  schemas: Map<string, ComponentSchema>
}

/** The top-level ECS + Network container. Extends bitECS's World with engine bindings. */
interface World extends BitECSWorld {
  // Time
  frameTime: number
  simulationTime: number
  fixedTimeStep: number
  deltaSeconds: number
  accumulator: number

  // Realtime bindings
  network: RealtimeBindings

  // Entity identity caches (maintained by observers on BelongsTo + UIDComponent)
  /** parent entity → (uid → child entity) */
  nameCache: Map<Entity, Map<string, Entity>>
}

/**
 * Create a new Connection Engine world.
 * Wraps bitECS createWorld() and initialises realtime bindings + engine state.
 *
 * @param options.fixedTimeStep - Simulation tick rate in seconds (default: 1/60)
 */
declare function createWorld(options?: { fixedTimeStep?: number }): World

/**
 * Destroy a world, removing all entities, disconnecting all active peer connections,
 * and cleaning up runtime bindings.
 */
declare function destroyWorld(world: World): void
```

**Realtime boundary:** This layer owns live ECS state and its replication semantics. Higher layers may persist or hydrate the same semantic structures, but low-frequency save/load of scenes and user data is intentionally out of scope here.

**Lifecycle:**

```
createWorld() → World
  - initialise time state
  - create empty realtime bindings
  - register in global Worlds set

destroyWorld(world)
  - remove all entities (cascading relationship cleanup)
  - disconnect all active peer connections
  - remove from Worlds set
```

### 3.2 Entity

An integer ID representing any thing in the engine - user, avatar, peer, scoreboard, spatial object, quest, faction. Has no data of its own; all state is in components and relationships.

```typescript
type Entity = number // bitECS entity ID - runtime-local, NOT networked
```

Entity indices (bitECS integer IDs) are specific to each engine runtime instance and are never sent over the network. The identity system (BelongsTo + UIDComponent) is what gets serialised. Entity creation on a receiving peer is driven by incoming replicated component/relation data, not by entity ID synchronisation.

```typescript
// --- Design-level function signatures. Wrap bitECS addEntity/removeEntity
//     with replication hooks and identity bookkeeping. ---

import { addEntity, removeEntity as bitECSRemoveEntity } from 'bitecs'

/**
 * Create a new entity in the world.
 * Wraps bitECS addEntity and emits an entity lifecycle mutation when relevant
 * to the active realtime session.
 *
 * @param options.uid      - Optional UID (sets UIDComponent)
 * @param options.parent    - Optional BelongsTo parent (identity context)
 * @returns The new entity ID (local to this runtime)
 */
declare function createEntity(
  world: World,
  options?: {
    name?: string
    parent?: Entity
  }
): Entity

/**
 * Remove an entity from the world.
 * For each component: removeComponent (triggers observers + replication updates).
 * For each relationship: cascading cleanup per relation modifiers.
 * Emits the necessary removal mutations and calls bitECS removeEntity.
 */
declare function removeEntity(world: World, entity: Entity): void
```

**Lifecycle:**

```
createEntity(world) → Entity
  - bitECS addEntity
  - optionally: setComponent(UIDComponent) + addComponent(BelongsTo(parent))
  - entity lifecycle mutation queued for replication if relevant

removeEntity(world, entity)
  - for each component: removeComponent (triggers observers + replication updates)
  - for each relationship: cascading cleanup per relation modifiers
  - removal mutation emitted if relevant
  - bitECS removeEntity
```

### 3.3 Entity Identity

Entity identity is derived from **relationships and identity**, not a special-purpose UID component. An entity's unique address is its UID within the context of the entity it `BelongsTo`.

```typescript
// --- Design-level definitions. ---

import { createRelation } from 'bitecs'

/**
 * UIDComponent - a regular component, nothing special.
 * Stores the entity's UID within its BelongsTo parent scope.
 * Names are unique per BelongsTo parent, enforced by an onSet observer.
 */
const UIDComponent = defineComponent({
  id: 'UID',
  label: 'UID',
  schema: Schema.Object({
    /** The entity's UID - unique among siblings sharing the same BelongsTo target */
    value: Schema.String()
  })
})

/**
 * BelongsTo - identity/identity context (NOT the same as ChildOf).
 * ChildOf = entity hierarchy (transform inheritance, cascade delete).
 * BelongsTo = UID context (identity scope, identity resolution).
 * Exclusive: an entity belongs to exactly one identity context.
 */
const BelongsTo = createRelation({ exclusive: true })

// --- Lookup helpers. O(1) via the nameCache maintained by observers. ---

/**
 * Find an entity by UID within a parent's identity scope.
 * Uses the world.nameCache for O(1) lookup.
 *
 * @returns The entity, or undefined if no entity with that UID exists under parent.
 */
declare function getEntityByUID(world: World, parent: Entity, uid: string): Entity | undefined

/**
 * Get the full identity path for an entity by walking its BelongsTo chain.
 * Returns an array of names from root to entity, e.g. ['scene:MainArena', 'avatar:Player1'].
 * This is a query result (walk the chain), not a stored compound key.
 */
declare function getEntityPath(world: World, entity: Entity): string[]

/**
 * Resolve an entity from a path of names, walking BelongsTo contexts from root.
 * Inverse of getEntityPath.
 *
 * @param path - Array of names, e.g. ['scene:MainArena', 'avatar:Player1']
 * @returns The entity at the end of the path, or undefined if any segment is missing.
 */
declare function resolveEntityPath(world: World, path: string[]): Entity | undefined
```

**Uniqueness:** UIDs are unique per BelongsTo parent. Enforced by an `onSet` observer on UIDComponent that checks for duplicate UIDs among siblings sharing the same BelongsTo target.

**Addressing:** An entity's globally unique path is its BelongsTo chain + UID at each level:

```
root → scene → modelInstance → bone
```

This is a query result (walk the BelongsTo chain), not a stored compound key.

**Top-level entities** (scenes, users, networks) use their UID directly as their unique identifier within the root engine context - no BelongsTo parent needed.

**Lookup:**

```typescript
// Find entity by UID within a parent context
const entities = query(world, [BelongsTo(parentEntity), UIDComponent])
// filter where UIDComponent.value[entity] === targetUID

// Caches per-parent (uid → entity Map) are maintained by observers
// on BelongsTo and UIDComponent changes. O(1) cached lookup.
```

**Why not a compound UID component:**

- Eliminates special-case infrastructure (internal bidirectional maps, custom API surface)
- Identity falls out of the same relationship + query primitives used everywhere else
- Consistent with "everything is an entity" and "fewest abstractions"
- BelongsTo context is more expressive - an entity can belong to a scene, a model, a user, etc.

**BelongsTo vs ChildOf - these are distinct:** | Relationship | Purpose | Example | |-------------|---------|---------| | `ChildOf` | Entity hierarchy - transform inheritance, cascade delete | Bone → Armature → Avatar | | `BelongsTo` | Identity context - UID scope, uniqueness enforcement | Entity → Scene, Entity → Model instance |

An entity can have both: `ChildOf(armatureNode)` for transform hierarchy AND `BelongsTo(modelInstance)` for identity context. These often align but don't have to.

**Decentralised identity foundation:** User entities map to DID identities (Ed25519). Each user has a `did:key` that provides the cryptographic foundation for entity ownership and authority. Every state change in the ECS can be represented as a signed semantic triple authored by a peer DID - giving cryptographic provenance to every mutation. This means entity ownership is cryptographically verifiable by any peer, not just convention.

### 3.4 ComponentDefinition

A named, schema-driven component type. Defined via a single options object with `id`, `label`, `schema`, and optional `mutationCategory`. The schema is a **single recursive structure** that defines field types, storage layout (SoA vs instance), defaults, and validation. Public schema authoring uses a unified `Schema` namespace: `Schema.String`, `Schema.Boolean`, `Schema.Number`, etc. wrap plain TypeBox-backed primitives, while `Schema.Vec3`, `Schema.Quat`, and related helpers cover ECS-specific value types. A component definition produces a **ComponentSchema** - a SHACL shape with action semantics. The `defineComponent` call generates the SHACL shape that drives validation and governance.

**Mutation categories** determine how changes to a component propagate over the network:

| Category | Intent | Transport | Validation | Persistence |
| --- | --- | --- | --- | --- |
| **authored** | Deliberate, infrequent, often user-initiated. Scene edits, avatar customisation, inventory changes, entity spawns. | **Reliable transport** - queued per-frame, batched, sent end-of-tick as ordered structured mutations. | **Full governance** - ZCAP capabilities, VC credentials, temporal rate limits, content validation. Validated at the transport layer before propagation. | **Event-sourced** - each mutation is recorded in the authored event log. World state = initial snapshot + replaying all authored mutations. |
| **runtime** | Continuous, often physics/system-driven. Transform updates, velocity changes, animation weights. | **Binary transport** - SoA binary-packed via bitECS serializers, sent at the simulation tick rate (configurable lower per-component), unreliable/unordered. Delta compression with dirty flags + periodic full state syncs. | **Authority check only** - is this peer authoritative for this entity? No governance validation per packet. Application/context-specific logic for domain validation where needed. | **Ephemeral** - not event-sourced. Periodically snapshotted. Reconstructed from latest snapshot + live streams. |
| **local** | Never leaves the local runtime. Debug info, rendering hints, editor state. | **None** | **None** | **None** |

The mutation category is set at the **component level**, not per-field. A whole component is authored, runtime, or local. This avoids cumbersome per-property flags, odd ontological splits within a single component, and complex component lifecycles. If a piece of data has a different mutation intent, it belongs in a different component - e.g. `Transform` (runtime: continuous position/rotation) vs `SpawnPoint` (authored: a deliberately placed marker with a position).

The category is explicit in the component definition via `mutationCategory`. If omitted, the default is derived from the schema: components with SoA-typed fields (Vec3, Quat, Float32, etc.) default to `'runtime'`; components with only value-typed fields (number, string, boolean) default to `'authored'`. The default can always be overridden.

```typescript
// --- Design-level interfaces for component definitions. ---

import type { TObject as SchemaObject, Static } from '@sinclair/typebox'

/** SoA store - typed arrays keyed by field path, indexed by entity ID. */
type SoAStore<T extends SchemaObject> = {
  [K in SoAKeys<T>]: Float32Array | Float64Array | Int32Array | Uint32Array
}

/** Instance store - per-entity objects for non-SoA (reactive/local) fields. */
type InstanceStore<T extends SchemaObject> = {
  [entity: number]: { [K in InstanceKeys<T>]: Static<T['properties'][K]> }
}

/** Mutation category - how changes to this component propagate. */
type MutationCategory = 'authored' | 'runtime' | 'local'

/**
 * Options for defining a component. Passed as a single object to defineComponent().
 */
interface ComponentOptions<T extends SchemaObject = SchemaObject> {
  /** Machine-stable identifier - used for serialisation, network protocol, SHACL URIs. */
  id: string

  /** Human-readable label. */
  label: string

  /** The unified Schema definition that captures field types, defaults, and validation. */
  schema: T

  /**
   * How mutations to this component propagate over the network.
   * - 'authored': reliable, governance-validated, event-sourced (default for value-only schemas)
   * - 'runtime': binary transport, authority-checked, ephemeral (default for SoA-typed schemas)
   * - 'local': never replicated
   *
   * If omitted, derived from the schema's field types.
   */
  mutationCategory?: MutationCategory
}

/**
 * A registered component type. Returned by defineComponent().
 * Carries the schema, stores, and generated ComponentSchema - all derived
 * from the single unified Schema definition.
 */
interface ComponentDefinition<T extends SchemaObject = SchemaObject> {
  /** Machine-stable identifier */
  readonly id: string

  /** Human-readable label */
  readonly label: string

  /** The unified Schema definition */
  readonly $schema: T

  /** How mutations to this component propagate */
  readonly mutationCategory: MutationCategory

  /** SoA stores for SoA-typed fields (Vec3, Quat, Float32, etc.) */
  readonly $soaStore: SoAStore<T>

  /** Per-entity instance store for value-typed fields */
  readonly $store: InstanceStore<T>

  /** Generated SHACL shape with action semantics - the ComponentSchema.
   *  Used for validation, replication metadata, governance hooks, and higher-layer tooling/persistence integrations. */
  readonly componentSchema: ComponentSchema

  /** bitECS component ID (internal, used for query matching) */
  readonly $bitECSId: number
}

/**
 * Define a new component type.
 * Wraps bitECS defineComponent, generates SoA + instance stores from the schema,
 * and produces a ComponentSchema (SHACL shape) for validation, replication metadata, and governance hooks.
 *
 * @param options - Component definition options (id, label, schema, mutationCategory)
 * @returns A ComponentDefinition with stores and ComponentSchema ready to use
 *
 * @example
 * const Transform = defineComponent({
 *   id: 'Transform',
 *   label: 'Transform',
 *   mutationCategory: 'runtime',
 *   schema: Schema.Object({
 *     position: Schema.Vec3(),
 *     rotation: Schema.Quat(),
 *     scale:    Schema.Vec3(),
 *   }),
 * })
 *
 * // Access the generated SHACL shape:
 * Transform.componentSchema          // → ComponentSchema { shaclShape, mutationCategory }
 *
 * // Access SoA stores directly:
 * Transform.$soaStore.position.x[entity]  // → Float32
 */
declare function defineComponent<T extends SchemaObject>(options: ComponentOptions<T>): ComponentDefinition<T>
```

```typescript
// Example: Transform - runtime (continuous position/rotation, binary transport)
const Transform = defineComponent({
  id: 'Transform',
  label: 'Transform',
  mutationCategory: 'runtime', // explicit: continuous data, binary transport
  schema: Schema.Object({
    position: Schema.Vec3(),
    rotation: Schema.Quat(),
    scale: Schema.Vec3()
  })
})

// Example: Health - authored (discrete state changes, governance-validated)
const Health = defineComponent({
  id: 'Health',
  label: 'Health',
  // mutationCategory defaults to 'authored' (value-only schema)
  schema: Schema.Object({
    current: Schema.Number({ default: 100 }),
    max: Schema.Number({ default: 100 })
  })
})

// Example: SpawnPoint - authored (deliberately placed, infrequent changes)
const SpawnPoint = defineComponent({
  id: 'SpawnPoint',
  label: 'Spawn Point',
  mutationCategory: 'authored', // explicit: even though it has Vec3, this is authored data
  schema: Schema.Object({
    position: Schema.Vec3(),
    radius: Schema.Number({ default: 1.0 })
  })
})

// Example: DebugInfo - local only (never replicated)
const DebugInfo = defineComponent({
  id: 'DebugInfo',
  label: 'Debug Info',
  mutationCategory: 'local',
  schema: Schema.Object({
    label: Schema.String({ default: '' }),
    wireframe: Schema.Boolean({ default: false })
  })
})
```

**Mutation category derivation - explicit or defaulted from schema:**

```
if options.mutationCategory is specified:
  → use it directly
else:
  if schema has any SoA-typed fields (Vec3, Quat, Float32, etc.):
    → default: 'runtime'
  else if all fields are value types (number, string, boolean, enum):
    → default: 'authored'
```

The component definition object returned by `defineComponent` carries the schema, initialised SoA stores (for SoA fields), the instance store, the mutation category, and the generated ComponentSchema (SHACL shape) - all derived from the single options object. A single component can have both SoA and instance fields for storage purposes, but all fields share the same mutation category and therefore the same transport path. This is deliberate: it keeps the data flow simple and the component boundary clean.

**ComponentSchema generation:** The unified `Schema` namespace is TypeBox-backed, so a component definition generates JSON Schema natively while also mapping cleanly to a SHACL shape (SHACL extended with action semantics: constructors, setters, collections). This means component definitions are automatically shareable, AI-editable JSON documents that are queryable via SPARQL, validated by SHACL, and used for governance and tooling - all from the same definition.

### 3.5 ComponentInstance

The actual data for a component on a specific entity. Split between SoA stores (shared across all entities) and per-entity instance data.

```typescript
// SoA fields: accessed via component.position.x[entity], component.position.y[entity], etc.
// Instance fields: accessed via component.$store[entity].visible

type ComponentInstance<T extends SchemaObject> = {
  // Non-SoA fields only. SoA fields live in the shared stores.
  [K in InstanceKeys<T>]: Static<T['properties'][K]>
}
```

**Lifecycle:**

```
setComponent(world, entity, component, value?)
  if component not on entity:
    - bitECS addComponent (triggers onAdd observers)
    - create instance with defaults merged with value
    - sync SoA fields from instance → SoA stores
    - store instance in $store[entity]
    - if authored: queue structured mutation for end-of-tick batch
    - if runtime: mark dirty flag; binary transport picks up at tick rate
  else:
    - partial shallow merge of provided fields
    - sync SoA fields if changed
    - if authored: queue structured mutation for end-of-tick batch
    - if runtime: mark dirty flag; binary transport picks up at tick rate

getComponent(world, entity, component) → ComponentInstance
  - triggers onGet observers if registered

removeComponent(world, entity, component)
  - triggers onRemove observers
  - if authored: queue removal mutation for end-of-tick batch
  - if runtime: mark entity as removed from binary transport
  - clean up SoA stores for entity
  - delete $store[entity]
  - bitECS removeComponent
```

### 3.6 Observers (bitECS Hooks)

Observers are **immediately invoked hooks** that fire synchronously on component mutation. They are provided by bitECS's observer API and are useful for lightweight side effects - updating caches, enforcing constraints.

Observers are distinct from the **reactor** system (§3.10), which provides full reactive logic trees via DOMless SolidJS. Observers are hooks; reactors are reactive state management.

```typescript
import { observe, onAdd, onRemove, onSet, onGet, Or, Not, query } from 'bitecs'

// Observe entities gaining a component (or entering a query match)
const unsub = observe(world, onAdd(Transform, Health), (entity) => {
  // entity just gained both Transform AND Health
})

// Observe entities losing a component
observe(world, onRemove(Health), (entity) => {
  // entity just lost Health
})

// Observe component data being set (reactive change detection)
observe(world, onSet(Health), (entity, params) => {
  Health.current[entity] = params.current
  Health.max[entity] = params.max
  // Reactive replication updates happen via the engine's replication pipeline
})

// Observe component data being read (proxy-style interception)
observe(world, onGet(Health), (entity) => {
  return { current: Health.current[entity], max: Health.max[entity] }
})

// Composable with query operators
observe(world, onAdd(Or(DamageSource, HealSource)), (entity) => {
  // entity gained either DamageSource or HealSource
})

observe(world, onAdd(Transform, Not(Static)), (entity) => {
  // entity has Transform but NOT Static - it's dynamic
})
```

**Key bitECS observer features:**

- `onAdd(...terms)` - fires when entity matches the query (component added or relationship formed)
- `onRemove(...terms)` - fires when entity stops matching
- `onSet(component)` - fires when data is written via `set()`
- `onGet(component)` - fires on data access - useful for lazy computation or proxy patterns
- Composable with `Or`, `Not`, `And`, `Any`, `All`, `None`
- `observe()` returns an unsubscribe function
- Works with relationships: `onAdd(ChildOf(Wildcard))` fires when any ChildOf relation is added
- Works with `IsA` prefab inheritance - observers fire during inheritance propagation

### 3.7 RelationDefinition

A named relationship type with modifiers. Produces pairs. Relationships are semantic links - they replicate through the same mutation mechanism as components.

```typescript
// --- Design-level interfaces. ---

interface RelationDefinition<T = void> {
  name: string
  exclusive: boolean // one target per entity per relation
  autoRemoveSubject: boolean // cascade delete when target removed
  store?: () => T // data attached to each pair
  onTargetRemoved?: (subject: Entity, target: Entity) => void
  mutationCategory: 'authored' | 'local' // relationships are always discrete; authored (replicated) or local
}

/**
 * Define a named relation type.
 * Wraps bitECS createRelation and adds:
 * - A name for serialisation (maps to a predicate URI, e.g. 'ce:ChildOf')
 * - A mutation category (authored by default - replicated as discrete mutations; local = never synced)
 * - Realtime integration - relationship add/remove queued as authored mutations for end-of-tick batch
 *
 * @param name    - Relation name (used as the predicate in structured semantic mutations)
 * @param options - bitECS relation modifiers + mutation category
 * @returns A relation usable with bitECS addComponent(world, entity, Relation(target))
 *
 * @example
 * const ChildOf = defineRelation('ChildOf', {
 *   exclusive: true,
 *   autoRemoveSubject: true,  // removing parent cascades to children
 *   mutationCategory: 'authored',
 * })
 *
 * const LocallyRelevant = defineRelation('LocallyRelevant', {
 *   exclusive: false,
 *   mutationCategory: 'local', // derived locally, never replicated
 * })
 *
 * const EquippedBy = defineRelation('EquippedBy', {
 *   exclusive: true,
 *   store: () => ({ slot: '' as string }),  // data on the relation pair
 *   mutationCategory: 'authored',
 * })
 */
declare function defineRelation<T = void>(
  name: string,
  options: {
    exclusive?: boolean
    autoRemoveSubject?: boolean
    store?: () => T
    onTargetRemoved?: (subject: Entity, target: Entity) => void
    mutationCategory?: 'authored' | 'local'
  }
): RelationDefinition<T>
```

All relationships are authored by default - adding/removing a relationship is a discrete semantic mutation, queued for end-of-tick batch delivery via reliable transport. The only question is whether it replicates to peers or stays local to this runtime.

### 3.8 RelationshipPair

An instance of a relation between two entities. Structurally a semantic triple: `<subject, relationType, target>`.

```typescript
// Created via: addComponent(world, subject, Relation(target))
// Queried via: query(world, [Relation(target)]) or query(world, [Relation(Wildcard)])
// Data accessed via: Relation(target).fieldName[subject]
// Replicated as an authored mutation - queued for end-of-tick batch on the reliable transport path
```

### 3.9 Query

Finds entities matching a set of component and relationship criteria. bitECS queries are O(1) per archetype table via component ID indexing. Relationship pairs get unique component IDs, so relationship queries are the same mechanism.

```typescript
// bitECS query (already exists)
const results = query(world, [Transform, Health])
const children = query(world, [ChildOf(parent)])
const allOwned = query(world, [OwnedBy(Wildcard)])

// Operators compose
query(world, [Or(DamageSource, HealSource)])
query(world, [Transform, Not(Static)])

// Hierarchy traversal
query(world, [Hierarchy(ChildOf)]) // all descendants via ChildOf
query(world, [Cascade(ChildOf)]) // cascading query

// Modifiers
query(world, [Transform], asBuffer) // return as Uint32Array
query(world, [Transform], noCommit) // skip deferred removals
```

**Reactive queries** - handled by the observer API (see §3.6). `observe(world, onAdd(...terms), callback)` is the enter/exit mechanism. No separate ReactiveQuery abstraction needed.

### 3.10 System

A function that operates on queried entities within a specific phase. Can run in main thread, web worker (via SAB), or on server.

**Design: declarative API, extensible via injection.** Systems are free to read and write what they need - no explicit dependency declarations or system DAG. Injection is a declarative API for updating the system executor order at runtime. Fixed vs variable timestep is implicit in which phase a system is injected into (Simulation phase runs in fixed timestep, others run at frame rate).

Systems have two kinds of logic:

- **Continuous logic** (`execute`) - loop functions that run every tick. Physics stepping, transform interpolation, animation blending. These are the hot path - tight loops over SoA data.
- **Reactive logic** (`reactor`) - a function that returns a DOMless SolidJS component (logic-only, no DOM rendering). SolidJS signals, effects, and memos drive reactive state management - state transitions, game rule evaluation. Reactors are mounted once when the system initialises and unmounted when it's torn down, running continuously via Solid's reactive graph.

The bitECS `observe` API (`onAdd`, `onRemove`, `onSet`, `onGet`) is a separate hook system - immediately invoked callbacks that fire synchronously on component mutation. Useful for lightweight side effects (updating caches, enforcing constraints) but distinct from the reactive system. Observers are hooks; reactors are reactive logic trees.

```typescript
// --- Design-level interfaces for the system API. ---

/** Execution phases, run in fixed order each frame. */
type Phase = 'Input' | 'Simulation' | 'Animation' | 'Render'

/** Where the system's execute function runs. */
type ExecutionContext = 'main' | 'worker' | 'server'

/** A SolidJS component function (DOMless - logic only, no JSX/DOM). */
type ReactorFunction = () => void

/**
 * Full system definition. Passed to defineSystem().
 */
interface SystemDefinition {
  /** Unique system name */
  name: string

  /** Which phase this system runs in (determines fixed vs variable timestep) */
  phase: Phase

  /** Where to execute (default: 'main') */
  context?: ExecutionContext

  /** Ordering hints - run before/after named systems within the same phase */
  before?: string[]
  after?: string[]

  /** Continuous logic - runs every tick in the phase loop */
  execute?: (world: World, deltaTime: number) => void

  /** Reactive logic - DOMless SolidJS component, mounted on init, unmounted on removal */
  reactor?: ReactorFunction
}

/** Handle returned by defineSystem, used for injection management. */
interface SystemHandle {
  readonly name: string
  readonly phase: Phase
  readonly definition: SystemDefinition
}

/**
 * Define and register a system in the world.
 * The system is immediately scheduled in its phase at the position
 * determined by before/after ordering hints.
 *
 * @returns A handle for later injection management (remove, reorder)
 */
declare function defineSystem(world: World, definition: SystemDefinition): SystemHandle

// --- Runtime injection API - add/remove/reorder systems dynamically. ---

/**
 * Inject a previously-defined system into a world (e.g. from a plugin or module).
 * Useful when systems are defined externally and injected at runtime.
 */
declare function injectSystem(world: World, handle: SystemHandle): void

/** Remove a system from the world. Unmounts its reactor if present. */
declare function removeSystem(world: World, handle: SystemHandle): void

/**
 * Reorder a system within its phase.
 * Updates before/after constraints and re-sorts the phase's system list.
 */
declare function reorderSystem(
  world: World,
  handle: SystemHandle,
  ordering: {
    before?: string[]
    after?: string[]
  }
): void
```

```typescript
// System with both continuous and reactive logic
defineSystem(world, {
  name: 'HealthSystem',
  phase: 'Simulation',

  // Continuous: runs every tick in the phase loop
  execute: (world: World, deltaTime: number) => {
    // e.g., apply poison damage over time to all poisoned entities
  },

  // Reactive: DOMless SolidJS component, mounted on defineSystem, unmounted on system removal
  reactor: () => {
    createEffect(() => {
      // mount on system startup - reactive logic here
      return () => {
        /* cleanup on system teardown */
      }
    })
  }
})
```

**Phase execution:**

```
each frame:
  update world.frameTime, world.deltaSeconds, world.accumulator

  for phase in [Input, Simulation, Animation, Render]:
    if phase == Simulation:
      executeFixedTimestep(world, () => {
        for system in phase.systems (sorted by ordering):
          system.execute(world, fixedDeltaTime)
      })
    else:
      for system in phase.systems (sorted by ordering):
        system.execute(world, world.deltaSeconds)

// Reactors run via SolidJS's reactive graph - not tick-driven
// Observers fire synchronously when data changes - not tick-driven
```

### 3.11 Prefabs as ComponentSchema Compositions

A **prefab** (archetype) is a collection of ComponentSchemas (component definitions) that together define a networked entity type.

```typescript
// --- Design-level interfaces for the prefab API. ---

/**
 * A prefab definition - a named composition of component definitions
 * that together define a networked entity type.
 */
interface PrefabDefinition {
  /** Unique prefab name (e.g. 'Avatar', 'Vehicle', 'Collectible') */
  readonly name: string

  /** The component definitions that make up this prefab */
  readonly components: ReadonlyArray<ComponentDefinition>

  /**
   * Composed ComponentSchema - the union of all component schemas.
   * This is the full SHACL shape for the entity type:
   * - Drives sync (which fields sync how)
   * - Drives validation (SHACL constraints)
   * - Drives governance (which operations are allowed)
   * - Shareable: any peer receiving this schema knows the full data model
   */
  readonly composedSchema: ComponentSchema

  /** Default values per component, applied on instantiation */
  readonly defaults: Partial<{ [componentName: string]: Record<string, unknown> }>
}

/**
 * Define a prefab - a reusable entity archetype.
 * Composes multiple ComponentDefinitions into a single ComponentSchema.
 * The composed schema is registered with the world and shared through session/bootstrap metadata,
 * so connecting peers know the full data model for this entity type.
 *
 * @param name       - Unique prefab name
 * @param options.components - Component definitions to include
 * @param options.defaults   - Default values per component (merged with component-level defaults)
 *
 * @example
 * const AvatarPrefab = definePrefab('Avatar', {
 *   components: [Transform, MeshRenderer, Animator, Health, UIDComponent],
 *   defaults: {
 *     Health: { current: 100, max: 100 },
 *     Transform: { scale: [1, 1, 1] },
 *   },
 * })
 */
declare function definePrefab(
  name: string,
  options: {
    components: ComponentDefinition[]
    defaults?: Partial<{ [componentName: string]: Record<string, unknown> }>
  }
): PrefabDefinition

/**
 * Instantiate a prefab - create an entity with all the prefab's components
 * and register the composed ComponentSchema with the active runtime/session metadata.
 *
 * @param overrides - Per-component initial values (merged over prefab defaults)
 * @param options.parent - BelongsTo parent for identity context
 * @param options.uid   - Entity name within parent scope
 * @returns The new entity ID
 *
 * @example
 * const avatar = instantiatePrefab(world, AvatarPrefab, {
 *   Transform: { position: [0, 1, 0] },
 *   Health: { current: 80 },
 * }, { name: 'Player1', parent: sceneEntity })
 */
declare function instantiatePrefab(
  world: World,
  prefab: PrefabDefinition,
  overrides?: Partial<{ [componentName: string]: Record<string, unknown> }>,
  options?: { parent?: Entity; name?: string }
): Entity
```

```typescript
// A prefab declares which components are part of the type
// and how the runtime replicates them.
const AvatarPrefab = definePrefab('Avatar', {
  components: [Transform, MeshRenderer, Animator, Health, UIDComponent]
  // Each component brings its own ComponentSchema and mutation category
  // - the prefab composes them
  // The composed schema defines the full data model for this entity type
  // Transport path is per-component: Transform is runtime (binary),
  // Health/UIDComponent are authored (reliable)
})

// Instantiating a prefab creates an entity with all components
// and registers the composed ComponentSchema with the active session metadata
const avatar = instantiatePrefab(world, AvatarPrefab, {
  Transform: { position: [0, 1, 0] },
  Health: { current: 100, max: 100 }
})
```

**How prefabs compose ComponentSchemas:**

- Each component definition produces a ComponentSchema (SHACL shape)
- A prefab combines multiple shapes into a composite shape - the full data model for a networked entity type
- The composite shape drives sync (which fields sync how), validation (SHACL constraints), and governance (which operations are allowed)
- Prefabs are shareable as schema data - a world/session can declare "this runtime uses AvatarPrefab, VehiclePrefab, CollectiblePrefab" and any connecting peer knows the full data model

This replaces the need for custom serialization registration per entity type - the ComponentSchema composition IS the serialization contract. Note: the full lifecycle of how higher-level authored data expands into runtime entity hierarchies (loading models, resolving references, instantiating sub-hierarchies) is part of the **data-oriented content engine** scope - a separate exploration not yet covered.

### 3.12 Spatial Layer Boundary

Spatial concerns are intentionally out of scope for this foundational ECS/network layer. The next scope - the spatial layer - will define transforms as spatial relationships, WebXR spaces, zones, bounds, bounding trees, and the policies that decide which entities are relevant to which peers.

This layer only needs to provide the concepts that spatial systems will build on:

- entities, components, and relationships
- per-field sync modes
- peer/user/connection concepts
- ownership, authority, and governance hooks
- snapshots and replication semantics

The spatial layer will be responsible for:

- computing spatial membership / relevance
- defining zone or partition entities if needed
- deciding when entities enter or leave replication scope
- integrating spatial transitions with authority handoff

### 3.13 Realtime Transport & Mutation Pipeline

There are two adjacent concerns that should not be conflated:

- **Low-frequency save/load of spatial data and user data** - out of scope for this foundational ECS/network layer. Higher layers can persist or hydrate the same semantic model, but those storage flows are not specified here.
- **Realtime transport** - in scope. This layer defines how ECS mutations are replicated between peers during a live session, and the mutation pipeline that connects local ECS operations to the network.

Within this scope the runtime has **two realtime replication paths** driven by the component's mutation category:

- **Authored transport** for deliberate data (component changes, relationship mutations, entity lifecycle) - reliable, ordered, governance-validated, event-sourced
- **Runtime transport** for continuous data (SoA fields: positions, rotations, velocities) - binary-packed, fast, typically unreliable, authority-checked only

Both share the same schema (ComponentSchema), the same identity system, and the same entity model. The difference is mutation intent: authored mutations are meaningful state transitions that form the canonical event log; runtime mutations are ephemeral streams that are snapshotted periodically.

| Mutation Category | Realtime Path | Characteristics |
| --- | --- | --- |
| **Runtime** (transforms, IK, physics) | **Binary transport** - bitECS SoA serializer → WebRTC unreliable | At the simulation tick rate, unreliable, unordered. Delta compression with dirty flags + periodic full state syncs. Interpolation on receive. Authority check only - no governance per packet. |
| **Authored** (health, inventory, entity spawns, scene edits) | **Reliable transport** - reliable event delivery | Queued per-frame, batched end-of-tick. Reliable, ordered. Governance-validated at transport layer. Event-sourced. |
| **Persistent spatial/user data** | **Out of scope here** | Save/load and persistence belong to higher layers. |
| **Local** (debug, rendering hints) | **No replication** | Never leaves the local runtime. |

#### The Mutation Pipeline

**Emit side - how local changes reach the network:**

```
Local ECS operation (setComponent / removeComponent / addRelation / removeRelation)
  │
  ├─ if component.mutationCategory == 'authored':
  │     1. Change applied locally (SoA stores + instance store)
  │     2. Observers fire synchronously (onSet, onAdd, onRemove)
  │     3. Structured mutation queued in per-world authored mutation buffer
  │     4. At end of tick: batch all queued authored mutations
  │     5. Send batch via reliable transport to all relevant peers
  │     6. Append to local authored event log
  │
  ├─ if component.mutationCategory == 'runtime':
  │     1. Change applied locally (written directly to SoA stores)
  │     2. Dirty flag set on entity+component
  │     3. At binary transport tick (the simulation tick rate):
  │        a. Collect all dirty entities for this component
  │        b. Delta-compress against last-sent state
  │        c. Pack into binary buffer via bitECS SoA serializer
  │        d. Send via unreliable transport to all relevant peers
  │        e. Clear dirty flags
  │     4. Periodically (configurable): send full state sync (no delta) for convergence
  │
  └─ if component.mutationCategory == 'local':
        1. Change applied locally. No network activity.
```

**Receive side - how network changes reach the local ECS:**

```
Incoming authored mutation batch (reliable transport):
  1. For each mutation in batch:
     a. Validate against governance constraints (ZCAP, VC, temporal, content)
     b. If rejected: discard + log violation
     c. If accepted:
        - Resolve entity via identity system (BelongsTo + UID path → local entity ID)
        - If entity doesn't exist locally: create it (driven by incoming data)
        - Apply via setComponent/removeComponent with a 'network' origin tag
        - The origin tag prevents re-broadcast: observers and the mutation pipeline
          see that this change came from the network, so it is NOT re-queued
          for outbound replication
        - Observers fire normally (reactivity updates, cache maintenance, etc.)
        - Append to local authored event log

Incoming runtime binary packet (unreliable transport):
  1. Authority check: is the sending peer authoritative for these entities?
     - If not: discard silently (fast path, no governance overhead)
  2. Deserialise binary buffer via bitECS SoA deserializer
  3. Entity ID remapping (remote entity IDs → local entity IDs)
  4. Write directly into SoA stores (bypass setComponent, bypass observers)
     - This is the hot path - no governance, no event log, no reactivity overhead
  5. Interpolation layer smooths values for rendering
  6. Application/context-specific validation where needed
     (e.g. velocity clamping for anti-cheat - not general governance)
```

**The origin tag:** The key mechanism for preventing re-broadcast. When a mutation arrives from the network and is applied locally, it carries an origin tag ('network') that the outbound mutation pipeline checks. Locally-originated mutations have origin 'local' (the default). Only 'local' origin mutations are queued for outbound replication. This is simpler and more reliable than authority-based suppression - authority determines who CAN write, origin determines whether a specific write should propagate.

#### The Authored Event Log

Authored mutations form the **canonical event log** for a world's state. This is the persistence story:

- **World state** = initial snapshot + replaying all authored mutations in order
- **Runtime state** (transforms, velocities) is ephemeral - reconstructed from the latest periodic snapshot + live streams
- **Late join:** new peer receives current authored event log (or a snapshot derived from it) + current runtime state snapshot
- **Rollback:** replay authored mutations from a known-good point + discard runtime state (it regenerates from physics/systems)
- **Recording/replay:** authored event log IS the recording. Runtime state can be re-simulated from it.

The event log is append-only during a session. Compaction (snapshot + truncate) can happen at session boundaries or periodically.

**Binary packing for runtime data:**

bitECS provides serialization tools that handle the binary format:

- `createSoASerializer` / `createSoADeserializer` - binary serialization of SoA component arrays with diff support and epsilon-based change detection
- `createObserverSerializer` / `createObserverDeserializer` - serialization driven by observer events (add/remove), with entity ID mapping
- `createSnapshotSerializer` / `createSnapshotDeserializer` - full or partial world state to/from binary
- All support entity ID remapping (`Map<number, number>`) for network peers with different local IDs

**Delta compression for runtime transport:**

The runtime binary transport uses dirty flags + delta compression to minimise bandwidth:

- Each entity+component pair has a dirty bit, set when SoA stores are written
- At each binary transport tick, only dirty entities are serialised
- Delta against last-sent state: only changed fields are packed
- Periodic full state syncs (configurable interval) ensure convergence despite packet loss
- Epsilon-based change detection (bitECS native) avoids sending jitter noise

The high-frequency transport path packs SoA data into binary buffers and sends via DataChannels or equivalent realtime links. Higher-layer persistence can later consume the same semantic model, but persistence is not part of this section.

### 3.14 Per-Component Transport Configuration

How does the engine know that Transform data should sync at the simulation tick rate unreliably while Health data should sync reliably on change? Through the **mutation category** on the ComponentDefinition and/or runtime configuration for the active session/connections.

The mutation category (authored/runtime/local) determines the transport path. Runtime configuration can tune the parameters of that path - tick rate, delta compression settings, full-sync interval - without changing which path is used.

```typescript
// --- Design-level interfaces for transport configuration. ---

/** Per-component transport tuning for runtime-category components. */
interface RuntimeTransportConfig {
  /** Component id (must match a registered ComponentDefinition with mutationCategory: 'runtime') */
  component: string
  /** Binary transport tick rate in Hz (default: 60) */
  rate?: number
  /** Interval (in ticks) between full state syncs for convergence (default: 300 ticks ≈ 5 s at the default simulation tick rate) */
  fullSyncInterval?: number
  /** Whether to apply interpolation on the receiving end (default: true) */
  interpolate?: boolean
}

/** Full transport configuration for a world/session. */
interface TransportConfiguration {
  /** Per-component overrides for runtime transport parameters */
  runtimeComponents?: RuntimeTransportConfig[]
  /** Default runtime tick rate in Hz (default: 60) */
  defaultRate?: number
  /** Default full-sync interval in ticks (default: 300) */
  defaultFullSyncInterval?: number
}

/**
 * Apply transport configuration to a world/session.
 * Component definitions declare their mutation category (authored/runtime/local).
 * This configuration tunes the transport parameters for runtime-category components.
 *
 * @example
 * configureTransport(world, {
 *   runtimeComponents: [
 *     { component: 'Transform', rate: 30 },  // 30Hz instead of 60
 *   ],
 *   defaultRate: 60,
 * })
 */
declare function configureTransport(world: World, config: TransportConfiguration): void
```

The transport configuration drives:

- **How often** runtime data is sampled and sent (tick rate)
- **How often** full state syncs are sent for convergence
- **Whether** interpolation is applied on the receiving end
- **Which** session/runtime overrides apply beyond the component defaults

Authored components don't need rate configuration - they're batched end-of-tick and sent reliably whenever mutations occur.

### 3.15 Spatial Systems Boundary

Spatial indices, bounds, zone membership queries, and other spatial partitioning mechanisms are part of the next scope, not this document. This foundational layer only defines the replication primitives the spatial layer will rely on: component sync modes, snapshots, peer connections, ownership/authority, and governance hooks.

### 3.16 Network Topology & Agent-Centric Model

The networking layer supports both **client-server** and **peer-to-peer** topologies through an **agent-centric model**: each peer independently decides, based on shared rules, what data to send to and accept from other peers.

This is an engine-native model: shared rules (governance), local validation, no central authority. This foundational layer does **not** define spatial replication scopes. Higher layers - most likely the spatial layer - decide which entities are relevant to which peers. This layer defines the transport semantics, peer model, authority checks, and validation hooks that those higher-layer scopes rely on.

**Agent-centric principles:**

- Each peer evaluates shared rules locally to determine:
  - which entities/components/relations to replicate to which peers (based on higher-layer relevance rules, authority, and permissions)
  - which incoming data to accept or reject (based on authority, permissions, trust)
- Rules are shared across the session but evaluated independently
- No single peer is inherently "the server" - authority is per-entity, not per-peer
- A dedicated server peer is just a peer with broader authority rules (e.g. "this peer has authority over all scene-owned entities")

```typescript
// --- Design-level interfaces for world join/leave. ---

type TransportBackend = 'webrtc' | 'websocket'

/** Options for joining a networked world. */
interface JoinWorldOptions {
  /** The identifier or URL for the live multiplayer session */
  worldUrl: string
  /** The local user entity (must already exist with DID identity) */
  userEntity: Entity
  /** Optional: transport backend preference override */
  preferredBackend?: TransportBackend
}

/** Result of joining a world - the local peer entity and active connections. */
interface JoinWorldResult {
  /** The peer entity created for this engine instance in the remote world */
  peerEntity: Entity
  /** Active realtime connections for the joined session */
  connections: Connection[]
  /** Snapshot applied (true if late-join snapshot was received) */
  snapshotApplied: boolean
}

/**
 * Join a networked world.
 * Establishes realtime connections, creates a local peer entity,
 * receives the current world state (via snapshot/bootstrap),
 * and begins realtime replication.
 */
declare function joinWorld(world: World, options: JoinWorldOptions): Promise<JoinWorldResult>

/**
 * Leave a networked world.
 * Disconnects from all active connections, removes the local peer entity,
 * and cleans up replicated entities.
 * Owned entities are signalled for removal to other peers before disconnecting.
 */
declare function leaveWorld(
  world: World,
  options: {
    /** Peer entity to disconnect */
    peerEntity: Entity
    /** Whether to signal graceful departure (default: true) */
    graceful?: boolean
  }
): Promise<void>
```

**Late join:** All entities have an owner, and that owner (or a designated relay/host peer) is responsible for ensuring joining peers receive the full state of those entities. In server-hosted mode, peers send reactive mutations to the host and the host relays them to the rest of the session - same ownership model, centralised relay.

**What gets sent where (per-peer decision):**

```
each tick, for each connected peer:
  entities = selectReplicatedEntitiesForPeer(world, peer)  // higher-layer policy
  for each entity:
    if shouldReplicateTo(entity, peer, rules):
      for each networked component on entity:
        if component.mutationCategory == 'runtime' AND entity dirty for this component:
          queue SoA data for binary transport
        if component.mutationCategory == 'authored' AND has queued mutations:
          (already in the per-world authored mutation buffer)

on receiving data from peer:
  for each incoming mutation/binary data:
    if component.mutationCategory == 'authored':
      validate via governance (ZCAP, VC, temporal, content)
      if valid: apply with 'network' origin tag
    if component.mutationCategory == 'runtime':
      authority check only
      if authoritative: write directly to SoA stores
    else:
      reject / log
```

### 3.17 User, Peer & Connection

Users and peers are distinct concepts. A **User** is a person. A **Peer** is an engine instance - a single user can have many peers (multiple devices, multiple tabs). Both are entities.

```typescript
// --- Design-level interfaces. ---

// User entity - represents a person, persists across sessions
// Peer entity - represents one engine instance (browser tab, device)
// A user can have many peers: peer has BelongsTo(user) relationship

const BelongsTo = createRelation({ exclusive: true })
// addComponent(world, peerEntity, BelongsTo(userEntity))
// One peer belongs to one user, but one user can have many peers

type PeerID = string // session-level identifier

// User component (on the user entity)
const UserComponent = defineComponent({
  id: 'User',
  label: 'User',
  mutationCategory: 'authored',
  schema: Schema.Object({
    /** DID identity (did:key:...) - the cryptographic identity for this user */
    did: Schema.String(),
    /** Display name */
    displayName: Schema.String({ default: '' })
  })
})

// Peer component (on the peer entity)
const PeerComponent = defineComponent({
  id: 'Peer',
  label: 'Peer',
  mutationCategory: 'authored',
  schema: Schema.Object({
    peerId: Schema.String(),
    latency: Schema.Number({ default: 0 })
  })
})

// Connection - the live transport link to a peer
interface Connection {
  peer: Entity // the peer entity
  backend: TransportBackend
  metadata?: Record<string, unknown>
}

/**
 * Create or resolve a user entity from a DID identity.
 * If a user entity with this DID already exists in the world, returns it.
 * Otherwise creates a new user entity with UserComponent.
 *
 * @param options.did         - The user's DID (did:key:z6Mk...)
 * @param options.displayName - Human-readable display name
 * @returns The user entity
 *
 * @example
 * // Local user - DID obtained by the surrounding application/runtime
 * const me = createUser(world, { did: localDID, displayName: 'Josh' })
 */
declare function createUser(
  world: World,
  options: {
    did: string
    displayName?: string
  }
): Entity

/**
 * Create a peer entity for an engine instance, belonging to a user.
 * Each browser tab / device / server instance gets its own peer entity.
 * The peer entity is linked to its user via BelongsTo.
 *
 * @param options.user   - The user entity this peer belongs to
 * @param options.peerId - Unique peer identifier (typically generated)
 * @returns The peer entity
 *
 * @example
 * const myPeer = createPeer(world, { user: me, peerId: crypto.randomUUID() })
 * // myPeer now has: PeerComponent + BelongsTo(me)
 */
declare function createPeer(
  world: World,
  options: {
    user: Entity
    peerId?: string
  }
): Entity
```

**Ownership references users. Authority references peers.**

- **Ownership** (`OwnedBy`) - which _user_ created this entity. Not transferable - to transfer ownership, the entity is genuinely destroyed and recreated under the new owner. This is intentional: ownership preserves provenance and the agent-centric data model.
- **Authority** (`AuthoritativeFor`) - which _peer_ (engine instance) currently has write control. Transferable between peers - this is how authority moves between devices/tabs for the same user, or hands off to a different user's peer entirely (e.g., host migration, physics authority delegation).

```typescript
const OwnedBy = createRelation({ exclusive: true })
// Entity has one owner (a user). Not transferable.

const AuthoritativeFor = createRelation({ exclusive: true })
// Entity has one authoritative peer. Transferable.
// Exclusive: assigning new authority automatically removes old.
```

This separation means:

- A user can check "all entities I own" regardless of which device they're on
- Authority can seamlessly move between a user's peers (switching active device)
- Authority can transfer to a different user's peer (host migration, delegation)
- Ownership is stable and auditable - the owner is always the creator

**Peer disconnect:** When a user disconnects (all their peers leave), entities tied to that user are automatically removed (avatars, user-specific objects). Persistent game state (scores, leaderboards) is NOT tied to a user - it belongs to the network entity, game entity, or another context-appropriate parent, ensuring it survives user disconnects. Authority auto-recovery (owner's lowest peer takes over) handles the authority side.

### 3.18 Ownership & Authority

Expressed as entity relationships. Ownership targets users, authority targets peers.

```typescript
// --- Design-level interfaces for authority transfer. ---

/** Result of an authority request - accepted, rejected, or pending. */
type AuthorityRequestResult =
  | { status: 'granted'; capability: ZCAPCapability }
  | { status: 'denied'; reason: string }
  | { status: 'pending' }

/**
 * Request authority over an entity.
 * Sends a request to the entity's owner (or current authority holder).
 * The owner validates the request against governance constraints and,
 * if approved, dispatches a transferAuthorityOfObject to all peers.
 *
 * @param entity    - The entity to request authority over
 * @param requester - The peer entity requesting authority
 * @returns Promise resolving when the owner responds
 *
 * @example
 * const result = await requestAuthority(world, vehicleEntity, myPeerEntity)
 * if (result.status === 'granted') {
 *   // I now have write authority - AuthoritativeFor updated via reliable replication
 * }
 */
declare function requestAuthority(world: World, entity: Entity, requester: Entity): Promise<AuthorityRequestResult>

/**
 * Transfer authority of an entity to a new peer.
 * Only callable by the entity's owner user (or a peer with a valid
 * CapabilityConstraint for authority transfer).
 *
 * Dispatches via the reliable replication path - all peers receive the update.
 * The AuthoritativeFor relation is updated atomically (exclusive relation).
 *
 * @param entity  - The entity to transfer authority for
 * @param newPeer - The peer entity receiving authority
 */
declare function transferAuthority(world: World, entity: Entity, newPeer: Entity): void

/**
 * Create a ZCAP capability token granting specific permissions.
 * Used for fine-grained authority delegation - e.g., "this peer can modify
 * Transform on entities in this scene for the next 10 minutes."
 *
 * The capability is a signed, delegatable, revocable token per W3C ZCAP-LD.
 *
 * @param options.invoker    - DID of the peer being granted the capability
 * @param options.target     - Entity or scope the capability applies to
 * @param options.predicates - Which component/relation types the capability covers
 * @param options.delegatable - Whether the invoker can further delegate
 * @param options.expires    - Expiry timestamp (ms since epoch)
 * @returns A signed ZCAP capability
 *
 * @example
 * const cap = await createCapability(world, {
 *   invoker: peerDID,
 *   target: sceneEntity,
 *   predicates: ['ce:Transform', 'ce:MeshRenderer'],
 *   delegatable: false,
 *   expires: Date.now() + 10 * 60 * 1000, // 10 minutes
 * })
 */
declare function createCapability(
  world: World,
  options: {
    invoker: string // DID of the grantee
    target: Entity // entity or scope
    predicates: string[] // component/relation type URIs
    delegatable?: boolean
    expires?: number
  }
): Promise<ZCAPCapability>
```

**Authority transfer protocol** (same pattern as Ethereal Engine's [EntityNetworkState](https://github.com/EnchantmentEngine/EnchantmentEngine/blob/dev/packages/ecs/src/network/EntityNetworkState.tsx)):

```
1. Peer A dispatches: requestAuthorityOverObject(entityUUID, newAuthority: peerA)
2. Owner validates: only the owner user (or scene owner) can approve transfers
3. Owner dispatches: transferAuthorityOfObject(entityUUID, newAuthority: peerA)
4. All peers apply via reliable replication: update AuthoritativeFor relationship to peerA

Auto-recovery when authority peer disconnects:
  - Owner detects authority peer left the session
  - Owner's lowest-sorted peer ID takes over authority automatically
  - Dispatches transferAuthorityOfObject to claim
```

**Validation rules (see §3.20 for full governance model):**

```
on receiving replicated mutation from peer (at transport layer):
  // Validate via ZCAP capability chain
  capability = resolveCapability(triple.authorDID, triple.predicate, triple.scope)
  if !capability || !verifyZCAPChain(capability):
    reject triple

  // Fallback: check authority relationship
  authorityPeer = getRelationTargets(world, triple.entityUID, AuthoritativeFor)[0]
  if triple.authorPeerID !== authorityPeer && !capability:
    reject triple (unless governance rules allow)

on spawn:
  validate ownerDID === triple.authorDID (can only spawn as yourself, verified by signature)

on destroy:
  validate ownerDID === triple.authorDID (only owner can destroy, verified by signature)

on transfer authority:
  validate initiator has CapabilityConstraint for authority transfer
  OR validate initiator is owner user (or scene owner)
```

**Conflict resolution:** Custom eventually-consistent CRDT merge per-component. Exact strategies will emerge as components are built - EE solved this well and is the reference. The general principle is per-component policies, not a single global strategy.

### 3.19 Snapshot

Point-in-time capture of world state. Used for late join, rollback, and recording checkpoints. **Created ad hoc** - no fixed frequency or heuristic needed; snapshots are taken when needed (e.g., peer joining, scene save, pre-rollback).

```typescript
// --- Design-level interfaces for snapshot API. ---

import { createSnapshotSerializer, createSnapshotDeserializer } from 'bitecs'

/** Options for creating a snapshot. */
interface SnapshotOptions {
  /** Capture only entities matching these components (default: all entities) */
  filter?: ComponentDefinition[]
  /** Capture only entities in these zones (default: all zones) */
  zones?: Entity[]
  /** Include relationship data (default: true) */
  includeRelationships?: boolean
  /** Include governance constraints (default: true) */
  includeGovernance?: boolean
}

/** Metadata attached to a snapshot for identification and replay. */
interface SnapshotMetadata {
  /** World simulation time at capture */
  simulationTime: number
  /** Timestamp (wall clock) */
  timestamp: number
  /** Entity count in snapshot */
  entityCount: number
  /** Component definitions included */
  components: string[]
  /** Zone names included (empty = full world) */
  zones: string[]
}

/** A complete snapshot - binary data + metadata. */
interface Snapshot {
  /** Binary-packed world state (bitECS snapshot format) */
  data: ArrayBuffer
  /** Snapshot metadata */
  metadata: SnapshotMetadata
}

/**
 * Create a snapshot of the current world state (full or filtered).
 * Uses bitECS createSnapshotSerializer under the hood.
 *
 * @param options - Filter which entities/zones to capture (default: full world)
 * @returns A Snapshot with binary data and metadata
 *
 * @example
 * // Full world snapshot (for late join)
 * const snap = createSnapshot(world)
 *
 * // Partial snapshot (just one zone)
 * const zoneSnap = createSnapshot(world, { zones: [arenaZone] })
 */
declare function createSnapshot(world: World, options?: SnapshotOptions): Snapshot

/**
 * Apply a snapshot to a world - creates entities, sets components,
 * and establishes relationships from the snapshot data.
 * Used for late join, rollback, and scene loading.
 *
 * @param snapshot - The snapshot to apply
 * @param options.idMap - Entity ID remapping (remote IDs → local IDs). If not provided,
 *                        new local entity IDs are allocated and the map is populated.
 * @param options.merge - If true, merge with existing state (default: false = replace)
 *
 * @example
 * // Late join - apply snapshot from host, build ID map for future sync
 * const idMap = new Map<number, number>()
 * applySnapshot(world, hostSnapshot, { idMap })
 */
declare function applySnapshot(
  world: World,
  snapshot: Snapshot,
  options?: {
    idMap?: Map<number, number>
    merge?: boolean
  }
): void
```

```typescript
// Built on bitECS's createSnapshotSerializer/createSnapshotDeserializer
// Captures entities, components, and relationships as binary

// Create snapshot from current world state (ad hoc)
createSnapshot(world: World): Snapshot

// Apply snapshot to world (for late join or rollback)
applySnapshot(world, snapshot, { idMap })
```

### 3.20 Permissions / Rules (Governance)

Connection Engine's permission system is an **engine-native governance system** applied to replicated runtime operations. Rules are replicated as data and enforced at the transport/replication layer - the one component all peers agree on. Not application-enforced - **consensus-enforced**.

This is THE enforcement point for live multiplayer operations. Every replicated component update, relationship change, and entity spawn is validated before it is applied locally. A modified client cannot bypass rules because every peer independently validates incoming mutations against the same shared constraint set.

#### Constraint Types

Four constraint types mapped to spatial use cases:

**1. Capability constraints (ZCAP-based):** Gate which peers can modify which entities/components. Maps to ownership/authority validation. ZCAP delegation chains mean authority can be delegated cryptographically - "I give you permission to modify this entity's transform" as a signed capability token. Delegatable, revocable, verifiable by any peer.

**2. Credential requirements:** Require agents to hold Verifiable Credentials before performing spatial operations. Examples:

- "Must hold a 'verified human' credential to spawn entities" (anti-bot)
- "Must hold a 'moderator' credential to delete others' entities"
- "Must hold a 'builder' credential to modify scene geometry"
- "Must hold a 'member' credential to enter this zone"

**3. Temporal constraints:** Rate limits on spatial operations - max entity spawns per minute, cooldown on authority transfer requests, rate-limited position updates for anti-cheat. Derived from replicated event history (scan recent signed mutations by author and scope). No external rate-limit service needed - every peer can compute temporal state from the same shared runtime history.

**4. Content constraints:** Validation on component values - max entity scale, allowed mesh types, blocked content in text components, physics body mass limits, maximum velocity (anti-cheat). Applied to incoming component data before it enters the world.

#### Interfaces

```typescript
interface SpatialConstraint {
  scope: Entity // what entity hierarchy this applies to
  kind: 'capability' | 'credential' | 'temporal' | 'content'
}

// Capability: ZCAP delegation chain
interface CapabilityConstraint extends SpatialConstraint {
  kind: 'capability'
  invoker: PeerID
  predicates: string[] // which component types / relation types
  delegatable: boolean
  expires?: number
  proof: SignedProof
}

// Credential: require VCs
interface CredentialConstraint extends SpatialConstraint {
  kind: 'credential'
  requiredCredential: string
  operations: string[] // spawn, modify, delete
}

// Temporal: rate limits
interface TemporalConstraint extends SpatialConstraint {
  kind: 'temporal'
  minIntervalSeconds: number
  maxCountPerWindow: number
  windowSeconds: number
  appliesTo: string[]
}

// Content: value validation
interface ContentConstraint extends SpatialConstraint {
  kind: 'content'
  componentType: string
  fieldConstraints: Record<
    string,
    {
      min?: number
      max?: number
      pattern?: string
      blocklist?: string[]
    }
  >
}
```

```typescript
// --- Design-level API for governance operations. ---

/** Constraint component definitions - constraints are ECS-native entities. */
const CapabilityConstraintComponent = defineComponent({
  id: 'CapabilityConstraint',
  label: 'Capability Constraint',
  mutationCategory: 'authored',
  schema: Schema.Object({
    invoker: Schema.String(), // DID of the grantee
    predicates: Schema.Array(Schema.String()),
    delegatable: Schema.Boolean({ default: false }),
    expires: Schema.Optional(Schema.Number())
  })
})

const CredentialConstraintComponent = defineComponent({
  id: 'CredentialConstraint',
  label: 'Credential Constraint',
  mutationCategory: 'authored',
  schema: Schema.Object({
    requiredCredential: Schema.String(),
    operations: Schema.Array(Schema.String()) // 'spawn' | 'modify' | 'delete'
  })
})

const TemporalConstraintComponent = defineComponent({
  id: 'TemporalConstraint',
  label: 'Temporal Constraint',
  mutationCategory: 'authored',
  schema: Schema.Object({
    minIntervalSeconds: Schema.Number({ default: 0 }),
    maxCountPerWindow: Schema.Number({ default: Infinity }),
    windowSeconds: Schema.Number({ default: 60 }),
    appliesTo: Schema.Array(Schema.String())
  })
})

const ContentConstraintComponent = defineComponent({
  id: 'ContentConstraint',
  label: 'Content Constraint',
  mutationCategory: 'authored',
  schema: Schema.Object({
    componentType: Schema.String(),
    fieldConstraints: Schema.Record(
      Schema.String(),
      Schema.Object({
        min: Schema.Optional(Schema.Number()),
        max: Schema.Optional(Schema.Number()),
        pattern: Schema.Optional(Schema.String()),
        blocklist: Schema.Optional(Schema.Array(Schema.String()))
      })
    )
  })
})

/** Relation linking a constraint entity to its scope (the entity hierarchy it applies to). */
const HasConstraint = defineRelation('HasConstraint', {
  exclusive: false, // an entity can have many constraints
  mutationCategory: 'authored'
})

/**
 * Add a governance constraint to a scope.
 * Creates a constraint entity with the appropriate component,
 * links it to the scope entity via HasConstraint, and replicates it
 * reliably so all peers enforce it immediately.
 *
 * @param scope     - Entity the constraint applies to (world root, scene, or specific entity)
 * @param kind      - Constraint type
 * @param config    - Constraint-specific configuration
 * @returns The constraint entity
 *
 * @example
 * // Rate-limit spawns in the arena scene
 * addConstraint(world, arenaScene, 'temporal', {
 *   minIntervalSeconds: 5,
 *   maxCountPerWindow: 10,
 *   windowSeconds: 60,
 *   appliesTo: ['spawn'],
 * })
 *
 * // Require builder credential for scene modifications
 * addConstraint(world, builderZone, 'credential', {
 *   requiredCredential: 'BuilderPass',
 *   operations: ['modify', 'spawn'],
 * })
 */
declare function addConstraint(
  world: World,
  scope: Entity,
  kind: 'capability',
  config: Omit<CapabilityConstraint, 'scope' | 'kind'>
): Entity
declare function addConstraint(
  world: World,
  scope: Entity,
  kind: 'credential',
  config: Omit<CredentialConstraint, 'scope' | 'kind'>
): Entity
declare function addConstraint(
  world: World,
  scope: Entity,
  kind: 'temporal',
  config: Omit<TemporalConstraint, 'scope' | 'kind'>
): Entity
declare function addConstraint(
  world: World,
  scope: Entity,
  kind: 'content',
  config: Omit<ContentConstraint, 'scope' | 'kind'>
): Entity

/** Validation result for an incoming triple against governance constraints. */
interface ValidationResult {
  /** Whether the triple is allowed */
  allowed: boolean
  /** If rejected: which constraint(s) caused rejection */
  violations: Array<{
    constraint: Entity
    kind: SpatialConstraint['kind']
    reason: string
  }>
}

/**
 * Validate an incoming event (triple) against all applicable governance constraints.
 * This is the core governance function - called at the replication layer for every incoming
 * replicated mutation from every peer.
 *
 * Walks the entity hierarchy to collect all constraints in scope (most specific first),
 * then evaluates each constraint type in order: capability → credential → temporal → content.
 *
 * @param triple - The incoming signed triple to validate
 * @returns ValidationResult with allowed/denied and violation details
 */
declare function validateEvent(world: World, triple: SignedTriple): ValidationResult

/**
 * Resolve all constraints that apply to an entity, walking the scope hierarchy.
 * Returns constraints ordered from most specific (entity-level) to broadest (world root).
 *
 * Useful for UI: "what rules apply to this entity?" and for pre-validation:
 * "can I do this before submitting to replication?"
 *
 * @returns Array of constraint entities with their SpatialConstraint data
 */
declare function resolveConstraints(
  world: World,
  entity: Entity
): Array<{ entity: Entity; constraint: SpatialConstraint }>
```

#### Scope Inheritance

Constraints cascade down the entity hierarchy. A constraint on the world root applies to everything. A constraint on a scene applies to entities in that scene. A constraint on a specific entity applies only to it. More specific scopes take precedence.

```
World (root)
  └── has_constraint → [require 'verified human' credential for spawn]  ← applies to everything
  └── Scene: "Main Arena"
        └── has_constraint → [rate limit: max 10 spawns/minute]         ← applies to this scene
        └── Entity: "Treasure Chest"
              └── has_constraint → [capability: only holder can open]    ← applies to this entity
  └── Scene: "Builder Zone"
        └── has_constraint → [require 'builder' credential]             ← overrides world default
        └── has_constraint → [content: max scale 10.0]                  ← building limits
```

#### Enforcement Points

| Layer | Role | When |
| --- | --- | --- |
| **Transport / replication layer** (authoritative) | Reject invalid replicated mutations before application. This is where governance runs. THE enforcement point for live multiplayer operations. Applies to **authored** mutations only - runtime binary data is authority-checked, not governance-validated. | Every incoming authored mutation batch from every peer |
| **Runtime layer** (pre-validation) | Fast reject for UX feedback before submitting to replication. Same validation engine, run locally. | Before local authored operations are submitted to transport |
| **Application layer** (cosmetic) | Hide disallowed actions in UI. Read constraints, disable buttons, show "you can't do that" feedback. | UI rendering |

#### Rules as Data, Not Code

Governance rules are replicated data that evolves with the live session. An admin adds a rate limit by creating a constraint entity and linking it to the target scope - the constraint propagates via reliable replication, and all peers enforce immediately. No code deployment, no software update, no consensus-breaking migration.

```
// Admin creates a temporal constraint (as ECS operations):
constraintEntity = createEntity(world)
setComponent(world, constraintEntity, TemporalConstraintComponent, {
  minIntervalSeconds: 5,
  maxCountPerWindow: 10,
  windowSeconds: 60,
  appliesTo: ['spawn']
})
addComponent(world, constraintEntity, HasConstraint(sceneEntity))

// This propagates via reliable replication.
// All peers receive it. All peers enforce it. Immediately.
```

The rule vocabulary (which constraint types, which fields, which defaults) is extensible - new constraint kinds can be added as new component definitions without changing the governance engine.

#### Authority Validation

```
on receiving any replicated mutation from a peer (at transport layer):

  1. Resolve scope: walk entity hierarchy to find all applicable constraints
  2. For each constraint in scope (most specific first):

     CAPABILITY constraints:
       - Find CapabilityConstraint where invoker matches triple.authorDID
       - Verify ZCAP proof chain (delegation signatures, expiry, revocation)
       - Check predicates include the triple's component type / relation type
       - If valid capability found → triple is authorised for this predicate

     CREDENTIAL constraints:
       - Check triple.authorDID holds required Verifiable Credential
       - Match operation type (spawn, modify, delete) against constraint
       - If credential missing → reject with reason


     TEMPORAL constraints:
       - Scan recent triples in scope by author DID
       - Check minIntervalSeconds since last matching triple
       - Check maxCountPerWindow within windowSeconds
       - If rate exceeded → reject with cooldown information

     CONTENT constraints:
       - Validate triple data against fieldConstraints (min, max, pattern, blocklist)
       - If any field fails → reject with field-level reason

  3. If no constraint explicitly grants permission and the operation requires authority:
     - Fall back to AuthoritativeFor relationship check

  4. All constraints pass → accept triple into local world
```

---

### 3.21 Scene (Higher-Layer Concept)

Scenes, reference spaces, authored spatial content, and save/load flows belong to later spatial/content scopes, not this foundational ECS/network layer.

The only assumptions this layer makes are:

- a scene-like entity may act as a `BelongsTo` identity context
- `ChildOf` and `BelongsTo` are sufficient to describe hierarchy + identity when higher layers introduce scenes
- snapshots may be used to bootstrap runtime state for scene-like structures

Detailed scene loading, persistence, collaborative authoring, and reference-space handling are intentionally deferred.

---

## 4. Mutation Category Summary

| Mutation Category | Typical Data | Storage | Transport | Validation | Persistence |
| --- | --- | --- | --- | --- | --- |
| **Runtime** | SoA fields (Vec3, Quat, Float32...) | Contiguous typed arrays | **Binary transport** - bitECS SoA serializer → WebRTC unreliable. Delta compression with dirty flags + periodic full state. Interpolated on receive. | Authority check only | Ephemeral - periodically snapshotted |
| **Authored** | Value fields (number, string, boolean, enum), relationships, entity lifecycle | Per-entity instance store, bitECS pairs | **Reliable transport** - queued per-frame, batched end-of-tick. Ordered, governance-validated. | Full governance (ZCAP, VC, temporal, content) | Event-sourced - canonical event log |
| **Local** | Debug, rendering hints, editor state | Per-entity instance store | **None** | **None** | **None** |
| **Persistent spatial/user data** |  |  | **Out of scope here** |  | Save/load belongs to later scopes |

The mutation category is set at the component level (not per-field) via `mutationCategory` in the `defineComponent` options. Defaults are derived from schema field types if not explicitly specified. Relationships default to authored. Runtime configuration (`configureTransport`) can tune transport parameters (rate, full-sync interval, interpolation) without changing the mutation category.

---

## 5. Key Relationships Between Items

| From | Relationship | To | Cardinality | Notes |
| --- | --- | --- | --- | --- |
| World | creates | Entity | 1:N |  |
| World | registers | ComponentDefinition | 1:N |  |
| World | registers | RelationDefinition | 1:N |  |
| World | schedules | System | 1:N |  |
| World | has | Connection | 1:N | Active peer links for live replication |
| Entity | has | UIDComponent | 1:1 | Unique per BelongsTo parent |
| Entity | BelongsTo | Entity (parent context) | N:1 | Identity/identity scope |
| Entity | has | ComponentInstance | 1:N | Via addComponent |
| Entity | has | RelationshipPair | 1:N | Via addComponent with relation |
| ComponentDefinition | IS | ComponentSchema | 1:1 | SHACL shape with action semantics |
| ComponentDefinition | has | Schema | 1:1 | Unified `Schema` definition |
| ComponentDefinition | has | MutationCategory | 1:1 | authored / runtime / local |
| ComponentInstance | writes to | SoAStore | 1:N | For SoA fields |
| ComponentInstance | writes to | InstanceStore | 1:1 | For value fields |
| ComponentInstance | replicates via | Connection | 1:N | For networked components |
| RelationshipPair | links | Entity (subject) | N:1 |  |
| RelationshipPair | links | Entity (target) | N:1 |  |
| RelationshipPair | replicates via | Connection | 1:N | For networked relationships |
| System | belongs to | Phase | N:1 |  |
| System | reads/writes | Query | N:M |  |
| Query | matches | ComponentDefinition | N:M |  |
| Query | matches | RelationshipPair | N:M | Incl. wildcards |
| Connection | links | Peer (entity) | N:1 |  |
| Peer | BelongsTo | User (entity) | N:1 | One user, many peers |
| Snapshot | captures | World state | 1:1 | Point-in-time bootstrap / rollback |
| Permissions | validates | incoming replicated mutations | N:M | Via governance at the replication layer |

---

## 6. Open Items Within This Scope

| # | Item | Status | Notes |
| --- | --- | --- | --- |
| 1 | Spatial scoping / zones / bounding trees | **Deferred to next scope** | The spatial layer will define transforms, WebXR, zones, bounds, relevance policies, and scope transitions. |
| 2 | Low-frequency save/load of spatial data and user data | **Out of scope** | Higher-level persistence/authoring layers may use the same semantics, but this document does not specify them. |
| 3 | Cross-peer entity identity | **Resolved** | Entity indices (bitECS integer IDs) are NOT networked - they are runtime-local. The identity system (BelongsTo + UIDComponent) is what gets serialised. Entity creation on a receiving peer is driven by incoming replicated component/relation data, not ID sync. |
| 4 | Observer → replication emission path | **Resolved** | Mutation pipeline uses origin tags ('local' vs 'network') to prevent re-broadcast. Authored mutations: `setComponent` → queued in per-world buffer → batched end-of-tick → reliable transport. Runtime mutations: write to SoA → dirty flag → binary packer reads at tick rate. See §3.13 for full pipeline. |
| 5 | Governance vs runtime binary data | **Resolved** | Governance validates authored mutations only. Runtime binary data gets authority checks only (is this peer authoritative?). Application/context-specific validation for domain concerns (e.g. velocity clamping). |

---

## 7. Next Steps

1. **Specification cases** — derive from each item's pseudocode: entity lifecycle, component lifecycle (all three mutation categories), relationship lifecycle, snapshot create/apply, authority validation (request/transfer/auto-recovery), authored mutation pipeline (queue/batch/send/receive/validate/event-log), runtime binary transport (dirty flags/delta/full-sync/authority-check), governance constraint validation (all four types).
2. **Unit tests** — translate spec cases into Vitest tests against the interfaces defined above.
3. **Implementation** — build against the tests, starting with the core path: Entity + UIDComponent + BelongsTo (identity) + ComponentDefinition (schema-driven mutation categories + ComponentSchema generation) + setComponent (with authored mutation queue + runtime dirty flags) + authored mutation pipeline + runtime binary transport + governance constraint enforcement.
4. **Next scope** — move into the spatial layer for transforms, WebXR, zones, bounds, bounding trees, and relevance policies.

Physics worker and spatial foundations are a separate exploration - see `plans/physics-spatial-exploration.md`.

---

## 8. Remaining Open Questions

### Authored/Runtime Boundary: Edge Cases & Examples

§3.4 (ComponentDefinition) × §3.13 (Realtime Transport & Mutation Pipeline)

**Resolved:** The mutation category is set at the component level, not per-field. The default is derived from schema field types (SoA → runtime, value-only → authored), explicitly overridable. This avoids per-field flags and keeps the component boundary clean.

**Remaining question:** Where exactly does the boundary fall in edge cases? The general principle is clear (deliberate/infrequent = authored, continuous/system-driven = runtime), but some components may not have an obvious home. Need to work through concrete examples during implementation:

- **Animation state** - blend weights change continuously (runtime), but animation trigger events are deliberate (authored). Split into two components?
- **Physics body config** (mass, friction) vs physics state (velocity, angular velocity) - config is authored, state is runtime. Separate components.
- **Audio source** - spatial position is runtime (follows transform), but play/stop/volume are authored events.
- **Visibility/LOD** - could be either. Scene-authored visibility = authored. Distance-based LOD = local.

**Explore during:** implementation of the first complex entity types (avatar, vehicle, interactive object).

### Spatial Layer ↔ Realtime Transport Contract

§3.12 (Spatial Layer Boundary) × §3.16 (Topology) × §3.20 (Permissions)

Spatial concerns are out of scope here, but the next layer still needs a precise contract with this one.

**Remaining questions:**

- How does the spatial layer express which entities are relevant to which peers?
- What exact add/remove semantics should apply when an entity enters or leaves replication scope?
- How should grace periods and authority handoff be expressed when spatial scope changes?

**Explore as:** the first pass of the spatial layer exploration.

---

## 9. Implementation Dependency DAG

```
Tier 0 - Foundations (no dependencies, implement first)
├── World (§3.1)
├── Entity (§3.2)
├── bitECS integration (addEntity, removeEntity, addComponent, removeComponent)
└── DID/key integration (signing, verification)

Tier 1 - Core ECS (depends on: Tier 0)
├── ComponentDefinition (§3.4) ← World, Entity
│   ├── Schema definition → SoA + instance stores
│   ├── Mutation category derivation (authored/runtime/local)
│   └── ComponentSchema (SHACL shape) generation
├── ComponentInstance (§3.5) ← ComponentDefinition, Entity
│   └── setComponent / getComponent / removeComponent → reactive/binary replication hooks
├── RelationDefinition (§3.7) ← World
│   └── createRelation (exclusive, autoRemoveSubject, withStore)
├── RelationshipPair (§3.8) ← RelationDefinition, Entity
└── Observers (§3.6) ← ComponentInstance, RelationshipPair
    └── onAdd, onRemove, onSet, onGet hooks

Tier 2 - Identity & Queries (depends on: Tier 1)
├── Entity Identity (§3.3) ← RelationshipPair (BelongsTo), ComponentInstance (UIDComponent), Observers
│   └── Uniqueness enforcement, cached lookups
├── Query (§3.9) ← ComponentDefinition, RelationshipPair
│   └── Component matching, relationship wildcards, Hierarchy/Cascade
└── User identity plumbing
    └── DID association on User entities

Tier 3 - Systems & Realtime Replication (depends on: Tier 2)
├── System (§3.10) ← Query, World
│   ├── Phase ordering (Input → Simulation → Animation → Render)
│   ├── Continuous execute loops
│   ├── Reactor (DOMless SolidJS components)
│   └── Injection API for runtime reordering
├── Realtime transport integration
│   ├── authored mutation pipeline (queue → batch → reliable transport + event log)
│   ├── runtime binary transport (dirty flags → delta compress → binary pack → unreliable)
│   ├── receive pipeline (origin tags, governance validation, authority checks)
│   └── peer connection lifecycle
├── Prefabs (§3.11) ← ComponentDefinition, ComponentSchema generation
│   └── ComponentSchema compositions defining networked entity types
└── Serialization ← ComponentDefinition, RelationshipPair, Entity Identity
    ├── bitECS SoASerializer / ObserverSerializer / SnapshotSerializer
    └── Entity ID mapping (local ↔ network)

Tier 4 - Multiplayer Semantics (depends on: Tier 3)
├── User / Peer / Connection (§3.17) ← Entity Identity, User identity plumbing, RelationshipPair
│   └── BelongsTo (peer → user), PeerComponent
├── Ownership & Authority (§3.18) ← User/Peer, RelationshipPair
│   └── OwnedBy (user), AuthoritativeFor (peer)
├── Governance (§3.20) ← Ownership/Authority, User identity plumbing
│   ├── CapabilityConstraint (ZCAP chains)
│   ├── CredentialConstraint (VC requirements)
│   ├── TemporalConstraint (rate limits)
│   ├── ContentConstraint (value validation)
│   └── Transport-layer enforcement
└── Snapshot (§3.19) ← Serialization
    └── Late join, rollback, bootstrap

Deferred to next scopes
├── Spatial layer
│   ├── transforms, WebXR, zones, bounds, bounding trees, relevance policies
│   └── authority handoff during scope transitions
└── Persistence / authoring layer
    ├── low-frequency spatial/user-data save-load
    └── scene/reference-space/content workflows
```

### Critical path

```
World → Entity → ComponentDefinition → ComponentInstance → Observers
  → Entity Identity → Query → System → Mutation pipeline + transport integration
    → User/Peer → Ownership/Authority → Governance → Snapshot
```

### Parallelism opportunities

| While implementing...                     | Can also implement...                                          |
| ----------------------------------------- | -------------------------------------------------------------- |
| ComponentDefinition + ComponentInstance   | RelationDefinition + RelationshipPair (same tier)              |
| Entity Identity                           | User identity plumbing                                         |
| System                                    | Serialization, Prefabs (both depend on Tier 2, not each other) |
| Authored mutation pipeline                | Runtime binary transport (independent data paths)              |
| Mutation pipeline + transport integration | User/Peer/Connection (both depend on Tier 3)                   |
| Ownership & Authority                     | Governance constraint types (both depend on Tier 4)            |
| Snapshot                                  | Late-join/bootstrap verification cases                         |

---

## References

- [Building Games in ECS with Entity Relationships](https://ajmmertens.medium.com/building-games-in-ecs-with-entity-relationships-657275ba2c6c) - Sander Mertens (Flecs)
- [Flecs Relations Manual](https://www.flecs.dev/flecs/#/docs/Relationships)
- [JSON Logic](https://github.com/jwadhams/json-logic-js) - serializable rules
- [solid-three renderer](https://github.com/solidjs-community/solid-three/blob/main/src/renderer.tsx) - SolidJS DOMless renderer pattern
- bitECS 0.4.0 - `Relation.test.ts`, `Query.test.ts`, `Observer.test.ts`
- [W3C ZCAP-LD](https://w3c-ccg.github.io/zcap-spec/) - Authorization Capabilities for Linked Data
- [W3C Verifiable Credentials](https://www.w3.org/TR/vc-data-model-2.0/) - Verifiable Credentials Data Model
- [W3C SHACL](https://www.w3.org/TR/shacl/) - Shapes Constraint Language
- [W3C DID Core](https://www.w3.org/TR/did-core/) - Decentralized Identifiers
