# Spec 04: Systems, Prefabs & Serialization

## Project & Architecture Context

**Connection Engine** is a semantic spatial web engine — a multiplayer-first, data-driven TypeScript engine for real-time spatial experiences built on web standards.

**Core design principles:**

1. **Everything is an entity.** Users, avatars, scores, quests, factions, inventories — only engine runtime bindings live outside the ECS.
2. **Fewest abstractions.** One ECS/change model serves realtime replication, authority, validation, and persistence integrations.
3. **Component-level mutation categories.** Network behaviour is defined per-component as authored (reliable, governance-validated, event-sourced), runtime (binary, authority-checked, ephemeral), or local (never replicated).
4. **Semantic graph runtime.** The ECS is a graph of typed relationships — components are schemas, relationships are predicates, queries are pattern matching.

**Tech stack:** TypeScript, bitECS v4, TypeBox, Vitest

**Dependency chain:** This is Spec 04 (Tier 2–3). Depends on:

- `01-world-entity.md` — World, Entity, time state, `updateWorldTime`
- `02-component-definitions.md` — `defineComponent`, `setComponent`, `getComponent`, `ComponentDefinition`, `Schema`, observers
- `03-relations-identity.md` — `defineRelation`, `BelongsTo`, `UIDComponent`, identity path resolution

Depended on by:

- `05-mutation-pipeline.md` — uses system phases for tick timing, serialization for binary transport
- `06-users-peers-authority.md` — uses prefabs, snapshot/serialization for late join
- `07-governance.md` — uses systems for governance enforcement hooks

---

## Scope & Intent

This spec defines three interconnected subsystems:

1. **Systems** — the execution model for game logic. Systems run within ordered phases (Input → Simulation → Animation → Render), support fixed and variable timestep, provide both continuous (`execute`) and reactive (`reactor`) logic modes, and can be dynamically injected, removed, and reordered at runtime.

2. **Prefabs** — named compositions of `ComponentDefinition`s that define reusable entity archetypes. A prefab composes multiple `ComponentSchema`s into a single shareable schema, and `instantiatePrefab` creates fully initialised entities from them.

3. **Serialization** — converting component data between runtime representations and portable formats. Covers component ↔ JSON for authored data, SoA ↔ binary buffer for runtime data via bitECS serializers, full/partial world snapshots, and entity ID mapping between local and network representations.

---

## Requirements

### R1: System Phases

Execution is divided into four ordered phases. Each phase runs all its systems in dependency-sorted order before the next phase begins.

```typescript
/**
 * Execution phases, run in fixed order each frame.
 *
 * - Input:      Reads device/network input, updates input-mapped components. Variable timestep.
 * - Simulation: Physics, game rules, AI. Fixed timestep (world.fixedTimeStep).
 * - Animation:  Blend trees, IK, procedural animation. Variable timestep.
 * - Render:     Scene graph updates, draw calls, post-processing. Variable timestep.
 */
type Phase = 'Input' | 'Simulation' | 'Animation' | 'Render'

/**
 * The canonical phase execution order.
 * Simulation runs at a fixed timestep; all other phases run at the variable frame rate.
 */
const PHASE_ORDER: readonly Phase[] = ['Input', 'Simulation', 'Animation', 'Render'] as const
```

### R2: System Definition

```typescript
/**
 * Where the system's execute function runs.
 * - 'main':   main thread (default)
 * - 'worker': web worker via SharedArrayBuffer (for heavy compute)
 * - 'server': server-only system (not sent to clients)
 */
type ExecutionContext = 'main' | 'worker' | 'server'

/**
 * A DOMless SolidJS component function for reactive logic.
 * Returns void — this is logic-only, no DOM rendering.
 * Mounted once when the system initialises, unmounted when removed.
 * Uses SolidJS primitives (createSignal, createEffect, createMemo)
 * for reactive state management.
 */
type ReactorFunction = () => void

/**
 * Full system definition. Passed to defineSystem().
 */
interface SystemDefinition {
  /**
   * Unique system name. Used for ordering references (before/after)
   * and debug tooling.
   */
  name: string

  /**
   * Which phase this system runs in.
   * Determines fixed vs variable timestep:
   * - 'Simulation': fixed timestep (world.fixedTimeStep)
   * - All others: variable timestep (world.deltaSeconds)
   */
  phase: Phase

  /**
   * Where to execute.
   * @default 'main'
   */
  context?: ExecutionContext

  /**
   * Ordering hints — this system runs BEFORE the named systems
   * within the same phase. Ignored if the named system is in a different phase.
   */
  before?: string[]

  /**
   * Ordering hints — this system runs AFTER the named systems
   * within the same phase. Ignored if the named system is in a different phase.
   */
  after?: string[]

  /**
   * Continuous logic — runs every tick in the phase loop.
   * For Simulation phase: called once per fixed timestep iteration.
   * For other phases: called once per frame.
   *
   * @param world - The world being updated
   * @param deltaTime - Time step in seconds. For Simulation: world.fixedTimeStep.
   *                    For others: world.deltaSeconds.
   */
  execute?: (world: World, deltaTime: number) => void

  /**
   * Reactive logic — a DOMless SolidJS component function.
   * Mounted once when the system is injected/defined. Unmounted when removed.
   * Runs continuously via SolidJS's reactive graph — not tick-driven.
   *
   * Use for: state transitions, game rule evaluation, event-driven logic.
   * Distinct from bitECS observers (which are synchronous hooks).
   */
  reactor?: ReactorFunction
}
```

### R3: System Handle & defineSystem

```typescript
/**
 * Handle returned by defineSystem, used for injection management.
 * Immutable reference to a registered system.
 */
interface SystemHandle {
  /** The unique system name */
  readonly name: string
  /** The phase this system belongs to */
  readonly phase: Phase
  /** The full system definition */
  readonly definition: Readonly<SystemDefinition>
}

/**
 * Define and register a system in a world.
 *
 * 1. Validates the definition (unique name within world, valid phase)
 * 2. Resolves before/after ordering within the phase
 * 3. Inserts the system into the phase's sorted execution list
 * 4. If reactor is provided: mounts it via SolidJS createRoot
 * 5. Returns a SystemHandle for later injection management
 *
 * @param world - The world to register the system in
 * @param definition - The full system definition
 * @returns A SystemHandle for injection management
 * @throws Error if a system with the same name already exists in this world
 * @throws Error if before/after references create a cycle
 *
 * @example
 * const physicsHandle = defineSystem(world, {
 *   name: 'PhysicsSystem',
 *   phase: 'Simulation',
 *   after: ['InputSystem'],
 *   execute: (world, dt) => {
 *     const entities = query(world, [Transform, RigidBody])
 *     for (const entity of entities) {
 *       // physics stepping logic
 *     }
 *   },
 * })
 *
 * @example
 * const healthHandle = defineSystem(world, {
 *   name: 'HealthSystem',
 *   phase: 'Simulation',
 *   execute: (world, dt) => {
 *     // apply damage-over-time, regeneration, etc.
 *   },
 *   reactor: () => {
 *     // reactive logic: watch for health reaching zero
 *     createEffect(() => {
 *       // SolidJS reactive graph — fires when tracked state changes
 *     })
 *   },
 * })
 */
declare function defineSystem(world: World, definition: SystemDefinition): SystemHandle
```

#### Pseudocode

```
function defineSystem(world, definition):
  if world.systems.has(definition.name):
    throw Error(`System '${definition.name}' already defined in this world`)

  if definition.phase not in PHASE_ORDER:
    throw Error(`Invalid phase: ${definition.phase}`)

  handle = {
    name: definition.name,
    phase: definition.phase,
    definition: Object.freeze({ ...definition }),
  }

  // Insert into phase's system list with topological sort
  phaseList = world.systemsByPhase.get(definition.phase)
  insertWithOrdering(phaseList, handle, definition.before, definition.after)

  // Mount reactor if present
  if definition.reactor:
    dispose = solidjs.createRoot((dispose) => {
      definition.reactor!()
      return dispose
    })
    world.reactorDisposers.set(definition.name, dispose)

  world.systems.set(definition.name, handle)
  return handle
```

### R4: System Injection API

```typescript
/**
 * Inject a previously-defined system into a world.
 * Useful when systems are defined externally (plugins, modules)
 * and injected at runtime.
 *
 * If the system was previously removed from this world, it is re-added.
 * If it was never in this world, it is added fresh.
 * Its reactor (if any) is mounted on injection.
 *
 * @param world - The world to inject into
 * @param handle - The system handle (from a prior defineSystem call)
 * @throws Error if a system with the same name already exists in this world
 */
declare function injectSystem(world: World, handle: SystemHandle): void

/**
 * Remove a system from a world.
 * The system's reactor is unmounted (SolidJS dispose called).
 * The system is removed from its phase's execution list.
 * The handle remains valid — it can be re-injected later.
 *
 * @param world - The world to remove from
 * @param handle - The system handle to remove
 */
declare function removeSystem(world: World, handle: SystemHandle): void

/**
 * Reorder a system within its phase.
 * Updates before/after constraints and re-sorts the phase's system list.
 * Does NOT unmount/remount the reactor.
 *
 * @param world - The world
 * @param handle - The system handle to reorder
 * @param ordering - New ordering constraints (replaces existing)
 * @throws Error if the new ordering creates a cycle
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

#### Pseudocode

```
function injectSystem(world, handle):
  if world.systems.has(handle.name):
    throw Error(`System '${handle.name}' already exists in this world`)

  phaseList = world.systemsByPhase.get(handle.phase)
  insertWithOrdering(phaseList, handle, handle.definition.before, handle.definition.after)

  if handle.definition.reactor:
    dispose = solidjs.createRoot((dispose) => {
      handle.definition.reactor!()
      return dispose
    })
    world.reactorDisposers.set(handle.name, dispose)

  world.systems.set(handle.name, handle)

function removeSystem(world, handle):
  if !world.systems.has(handle.name):
    return  // no-op

  // Unmount reactor
  disposer = world.reactorDisposers.get(handle.name)
  if disposer:
    disposer()
    world.reactorDisposers.delete(handle.name)

  // Remove from phase list
  phaseList = world.systemsByPhase.get(handle.phase)
  phaseList.splice(phaseList.indexOf(handle), 1)

  world.systems.delete(handle.name)

function reorderSystem(world, handle, ordering):
  if !world.systems.has(handle.name):
    throw Error(`System '${handle.name}' not found in this world`)

  phaseList = world.systemsByPhase.get(handle.phase)
  phaseList.splice(phaseList.indexOf(handle), 1)
  insertWithOrdering(phaseList, handle, ordering.before, ordering.after)
```

### R5: Frame Loop & Phase Execution

The frame loop updates time state, then executes each phase in order. The Simulation phase uses a fixed timestep via the accumulator pattern; all other phases use the variable frame delta.

```typescript
/**
 * Execute one frame of the engine loop.
 *
 * Called once per frame by the host environment (requestAnimationFrame, setInterval, etc.).
 * The frame loop is NOT managed by Connection Engine — the host provides the timing.
 *
 * 1. Update world time state via updateWorldTime (Spec 01)
 * 2. Execute Input phase systems (variable timestep)
 * 3. Execute Simulation phase systems (fixed timestep, may run 0..N times)
 * 4. Execute Animation phase systems (variable timestep)
 * 5. Execute Render phase systems (variable timestep)
 *
 * @param world - The world to step
 * @param currentTime - Current time in seconds (e.g., performance.now() / 1000)
 *
 * @example
 * // Host-driven loop
 * function loop() {
 *   executeFrame(world, performance.now() / 1000)
 *   requestAnimationFrame(loop)
 * }
 * requestAnimationFrame(loop)
 */
declare function executeFrame(world: World, currentTime: number): void
```

#### Pseudocode

```
function executeFrame(world, currentTime):
  // 1. Update time
  updateWorldTime(world, currentTime)

  // 2. Input phase — variable timestep
  for system in world.systemsByPhase.get('Input'):
    if system.definition.execute:
      system.definition.execute(world, world.deltaSeconds)

  // 3. Simulation phase — fixed timestep
  while world.accumulator >= world.fixedTimeStep:
    for system in world.systemsByPhase.get('Simulation'):
      if system.definition.execute:
        system.definition.execute(world, world.fixedTimeStep)
    world.simulationTime += world.fixedTimeStep
    world.accumulator -= world.fixedTimeStep

  // 4. Animation phase — variable timestep
  for system in world.systemsByPhase.get('Animation'):
    if system.definition.execute:
      system.definition.execute(world, world.deltaSeconds)

  // 5. Render phase — variable timestep
  for system in world.systemsByPhase.get('Render'):
    if system.definition.execute:
      system.definition.execute(world, world.deltaSeconds)
```

### R6: World System State

The World interface (Spec 01) is extended with system execution state:

```typescript
/**
 * Extension to the World interface for system management.
 * These fields are initialised by createWorld and managed by the system API.
 */
interface World {
  // ... existing fields from Spec 01 ...

  /** All registered systems by name */
  systems: Map<string, SystemHandle>

  /** Systems grouped and sorted by phase */
  systemsByPhase: Map<Phase, SystemHandle[]>

  /** SolidJS dispose functions for mounted reactors */
  reactorDisposers: Map<string, () => void>
}
```

### R7: Prefab Definition

```typescript
/**
 * A prefab definition — a named composition of ComponentDefinitions
 * that together define a reusable entity archetype.
 *
 * The composed ComponentSchema is the union of all component schemas,
 * providing a full SHACL shape for the entity type. This drives:
 * - Sync (which fields sync how, per component mutation category)
 * - Validation (SHACL constraints)
 * - Governance (which operations are allowed)
 * - Shareability (any peer receiving this schema knows the full data model)
 */
interface PrefabDefinition {
  /** Unique prefab name (e.g. 'Avatar', 'Vehicle', 'Collectible') */
  readonly name: string

  /** The component definitions that make up this prefab */
  readonly components: ReadonlyArray<ComponentDefinition>

  /**
   * Composed ComponentSchema — the union of all component schemas.
   * jsonSchema combines all component JSON schemas as a composite.
   * shaclShape combines all component SHACL shapes.
   * mutationCategory reflects the most restrictive category present.
   */
  readonly composedSchema: ComposedComponentSchema

  /**
   * Default values per component ID, applied on instantiation.
   * Merged over component-level schema defaults.
   */
  readonly defaults: Readonly<Record<string, Record<string, unknown>>>
}

/**
 * A composed schema from multiple ComponentDefinitions.
 * Extends ComponentSchema (Spec 02) with composite metadata.
 */
interface ComposedComponentSchema {
  /** Composite JSON Schema (allOf combining each component's jsonSchema) */
  readonly jsonSchema: object

  /** Composite SHACL shape (combining all component shapes) */
  readonly shaclShape: object

  /**
   * Mutation categories present in this prefab, per component ID.
   * A prefab may mix authored, runtime, and local components.
   */
  readonly mutationCategories: Readonly<Record<string, MutationCategory>>

  /** The component IDs included in this composed schema */
  readonly componentIds: ReadonlyArray<string>
}
```

### R8: definePrefab

```typescript
/**
 * Define a prefab — a reusable entity archetype composed of ComponentDefinitions.
 *
 * 1. Validates all components are registered ComponentDefinitions
 * 2. Composes ComponentSchemas into a single ComposedComponentSchema
 * 3. Merges component-level defaults with prefab-level defaults
 * 4. Returns a frozen PrefabDefinition
 *
 * @param name - Unique prefab name
 * @param options - Components and optional per-component defaults
 * @returns A PrefabDefinition ready for instantiation
 * @throws Error if prefab name is already registered
 * @throws Error if any component is not a valid ComponentDefinition
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
    /** Component definitions to include in the prefab */
    components: ComponentDefinition[]
    /**
     * Default values per component ID.
     * Merged over component-level schema defaults on instantiation.
     */
    defaults?: Record<string, Record<string, unknown>>
  }
): PrefabDefinition
```

#### Pseudocode

```
function definePrefab(name, options):
  if prefabRegistry.has(name):
    throw Error(`Prefab '${name}' already defined`)

  // Compose schemas
  composedJsonSchema = {
    type: 'object',
    title: name,
    allOf: options.components.map(c => c.componentSchema.jsonSchema)
  }

  composedShaclShape = {
    '@id': `ce://${name}Shape`,
    '@type': 'sh:NodeShape',
    'sh:targetClass': `ce://${name}`,
    'sh:and': options.components.map(c => c.componentSchema.shaclShape)
  }

  mutationCategories = {}
  componentIds = []
  for comp of options.components:
    mutationCategories[comp.id] = comp.mutationCategory
    componentIds.push(comp.id)

  composedSchema = {
    jsonSchema: composedJsonSchema,
    shaclShape: composedShaclShape,
    mutationCategories,
    componentIds,
  }

  defaults = {}
  for comp of options.components:
    defaults[comp.id] = extractDefaults(comp.$schema)
  // Merge prefab-level defaults over component-level defaults
  if options.defaults:
    for [compId, overrides] of Object.entries(options.defaults):
      defaults[compId] = { ...defaults[compId], ...overrides }

  definition = Object.freeze({
    name,
    components: Object.freeze([...options.components]),
    composedSchema: Object.freeze(composedSchema),
    defaults: Object.freeze(defaults),
  })

  prefabRegistry.set(name, definition)
  return definition
```

### R9: instantiatePrefab

```typescript
/**
 * Instantiate a prefab — create an entity with all the prefab's components
 * and optionally set its identity (UID + BelongsTo parent).
 *
 * For each component in the prefab:
 * 1. Merge: schema defaults → prefab defaults → caller overrides
 * 2. Call setComponent(world, entity, component, mergedData)
 *
 * If options.uid is provided: sets UIDComponent (Spec 03)
 * If options.parent is provided: sets BelongsTo relation (Spec 03)
 *
 * The prefab's composedSchema is registered with world.network.schemas
 * for network discovery by connecting peers.
 *
 * @param world - The world to create the entity in
 * @param prefab - The PrefabDefinition to instantiate
 * @param overrides - Per-component data overrides (keyed by component ID)
 * @param options - Identity options
 * @returns The new entity ID
 *
 * @example
 * const avatar = instantiatePrefab(world, AvatarPrefab, {
 *   Transform: { position: [0, 1, 0] },
 *   Health: { current: 80 },
 * }, { uid: 'Player1', parent: sceneEntity })
 */
declare function instantiatePrefab(
  world: World,
  prefab: PrefabDefinition,
  overrides?: Record<string, Record<string, unknown>>,
  options?: {
    /** BelongsTo parent entity for identity context */
    parent?: Entity
    /** UID within the parent's identity scope */
    uid?: string
  }
): Entity
```

#### Pseudocode

```
function instantiatePrefab(world, prefab, overrides?, options?):
  entity = createEntity(world)

  // Set identity if provided
  if options?.parent:
    addRelation(world, entity, BelongsTo, options.parent)
  if options?.uid:
    setComponent(world, entity, UIDComponent, { value: options.uid })

  // Add each component with merged defaults + overrides
  for comp of prefab.components:
    if comp.id === 'UID' && options?.uid:
      continue  // already set above

    mergedData = { ...prefab.defaults[comp.id] }
    if overrides?.[comp.id]:
      Object.assign(mergedData, overrides[comp.id])

    setComponent(world, entity, comp, mergedData)

  // Register composed schema for network discovery
  world.network.schemas.set(prefab.name, prefab.composedSchema)

  return entity
```

### R10: Component ↔ JSON Serialization

Serialization of authored (instance-stored) component data to and from JSON. Used for the authored mutation pipeline (Spec 05), persistence integration, and debugging.

```typescript
/**
 * Serialize a component's data on an entity to a plain JSON-safe object.
 * Reads from both instance store and SoA stores.
 * SoA fields are converted to value arrays (e.g., Vec3 → [x, y, z]).
 *
 * @param world - The world
 * @param entity - The entity
 * @param component - The ComponentDefinition
 * @returns A JSON-serializable object, or undefined if entity lacks the component
 *
 * @example
 * const json = serializeComponentToJSON(world, entity, Transform)
 * // { position: [10, 0, 5], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }
 */
declare function serializeComponentToJSON(
  world: World,
  entity: Entity,
  component: ComponentDefinition
): Record<string, unknown> | undefined

/**
 * Deserialize a JSON object into component data on an entity.
 * Applies via setComponent — triggers observers and mutation pipeline.
 *
 * @param world - The world
 * @param entity - The entity
 * @param component - The ComponentDefinition
 * @param json - The JSON data to apply
 */
declare function deserializeComponentFromJSON(
  world: World,
  entity: Entity,
  component: ComponentDefinition,
  json: Record<string, unknown>
): void
```

#### Pseudocode

```
function serializeComponentToJSON(world, entity, component):
  if !hasComponent(world, entity, component):
    return undefined

  result = {}

  // Instance fields
  instanceData = component.$store.get(entity)
  if instanceData:
    Object.assign(result, structuredClone(instanceData))

  // SoA fields — read from typed arrays, convert to value arrays
  for soaField of getSoAFields(component.$schema):
    result[soaField] = readSoAFieldAsArray(component.$soaStore, entity, soaField)

  return result

function deserializeComponentFromJSON(world, entity, component, json):
  setComponent(world, entity, component, json)
```

### R11: SoA ↔ Binary Buffer Serialization

Binary serialization of runtime (SoA-stored) component data using bitECS's built-in serializers. Used for the runtime transport pipeline (Spec 05).

```typescript
import { createSoASerializer, createSoADeserializer } from 'bitecs'

/**
 * Create a binary serializer for a set of runtime components.
 * Wraps bitECS createSoASerializer with Connection Engine's component model.
 *
 * The serializer packs SoA typed arrays into a compact binary buffer,
 * supporting delta compression (only changed values since last serialization)
 * and epsilon-based change detection (ignores jitter noise).
 *
 * @param components - Runtime-category ComponentDefinitions to serialize
 * @returns A serializer function that produces an ArrayBuffer
 *
 * @example
 * const serialize = createRuntimeSerializer([Transform, Velocity])
 * const buffer = serialize(world, dirtyEntities)
 * // Send buffer via unreliable transport
 */
declare function createRuntimeSerializer(
  components: ComponentDefinition[]
): (world: World, entities: Entity[]) => ArrayBuffer

/**
 * Create a binary deserializer for a set of runtime components.
 * Wraps bitECS createSoADeserializer.
 *
 * Unpacks binary buffers directly into SoA stores.
 * Supports entity ID remapping (remote → local).
 *
 * @param components - Runtime-category ComponentDefinitions to deserialize
 * @returns A deserializer function that applies binary data to the world
 *
 * @example
 * const deserialize = createRuntimeDeserializer([Transform, Velocity])
 * deserialize(world, buffer, entityIdMap)
 */
declare function createRuntimeDeserializer(
  components: ComponentDefinition[]
): (world: World, buffer: ArrayBuffer, idMap?: Map<number, number>) => void
```

### R12: Snapshot — Create & Apply

```typescript
/**
 * Options for creating a snapshot of world state.
 */
interface SnapshotOptions {
  /**
   * Capture only entities that have ALL of these components.
   * If omitted, captures all entities in the world.
   */
  filter?: ComponentDefinition[]

  /**
   * Include relationship data in the snapshot.
   * @default true
   */
  includeRelationships?: boolean

  /**
   * Include governance constraint entities.
   * @default true
   */
  includeGovernance?: boolean
}

/**
 * Metadata attached to a snapshot for identification and context.
 */
interface SnapshotMetadata {
  /** World simulation time at capture (seconds) */
  simulationTime: number

  /** Wall-clock timestamp at capture (ms since epoch) */
  timestamp: number

  /** Number of entities captured */
  entityCount: number

  /** Component definition IDs included in the snapshot */
  components: string[]

  /** Relation definition names included (if includeRelationships) */
  relations: string[]
}

/**
 * A complete snapshot — binary data + metadata.
 */
interface Snapshot {
  /** Binary-packed world state (bitECS snapshot format) */
  data: ArrayBuffer

  /** Snapshot metadata */
  metadata: SnapshotMetadata
}

/**
 * Options for applying a snapshot to a world.
 */
interface ApplySnapshotOptions {
  /**
   * Entity ID remapping table: snapshot entity IDs → local entity IDs.
   * If provided but empty, new local IDs are allocated and the map is populated.
   * If not provided, entities are created with whatever IDs bitECS assigns.
   */
  idMap?: Map<number, number>

  /**
   * If true, merge snapshot data with existing world state.
   * Existing entities with matching identity paths are updated.
   * If false (default), the world is cleared before applying.
   * @default false
   */
  merge?: boolean
}

/**
 * Create a snapshot of the current world state.
 *
 * Captures all (or filtered) entities, their components, and their relationships.
 * Uses bitECS createSnapshotSerializer for binary packing.
 *
 * @param world - The world to snapshot
 * @param options - Filter and inclusion options
 * @returns A Snapshot with binary data and metadata
 *
 * @example
 * // Full world snapshot for late join
 * const snap = createSnapshot(world)
 *
 * // Filtered snapshot — only entities with Transform
 * const partial = createSnapshot(world, { filter: [Transform] })
 */
declare function createSnapshot(world: World, options?: SnapshotOptions): Snapshot

/**
 * Apply a snapshot to a world.
 *
 * Creates entities, sets components, and establishes relationships
 * from the snapshot's binary data. Handles entity ID remapping
 * for network scenarios where snapshot IDs don't match local IDs.
 *
 * @param world - The world to apply the snapshot to
 * @param snapshot - The snapshot to apply
 * @param options - ID mapping and merge options
 *
 * @example
 * // Late join — apply host's snapshot, build ID map for future sync
 * const idMap = new Map<number, number>()
 * applySnapshot(world, hostSnapshot, { idMap })
 * // idMap now contains: host entity ID → local entity ID
 */
declare function applySnapshot(world: World, snapshot: Snapshot, options?: ApplySnapshotOptions): void
```

#### createSnapshot Pseudocode

```
function createSnapshot(world, options?):
  // Determine entities to capture
  if options?.filter:
    entities = query(world, options.filter)
  else:
    entities = getAllEntities(world)

  // Collect component data
  components = getRegisteredComponents(world)
  relations = options?.includeRelationships !== false ? getRegisteredRelations(world) : []

  // Use bitECS snapshot serializer
  serializer = bitecs.createSnapshotSerializer(world, components.map(c => c.$bitECS))
  data = serializer(entities)

  metadata = {
    simulationTime: world.simulationTime,
    timestamp: Date.now(),
    entityCount: entities.length,
    components: components.map(c => c.id),
    relations: relations.map(r => r.name),
  }

  return { data, metadata }
```

#### applySnapshot Pseudocode

```
function applySnapshot(world, snapshot, options?):
  if options?.merge !== true:
    // Clear existing world state (entities only, keep registrations)
    for entity in getAllEntities(world):
      removeEntity(world, entity)

  // Prepare ID map
  idMap = options?.idMap ?? new Map()

  // Use bitECS snapshot deserializer
  components = snapshot.metadata.components.map(id => getComponentById(id))
  deserializer = bitecs.createSnapshotDeserializer(world, components.map(c => c.$bitECS))
  deserializer(snapshot.data, idMap)

  // Apply relationship data (if included)
  // Relationships are serialised as component pairs — bitECS handles this
  // via the snapshot serializer when relations are registered

  // Populate entity identity caches via existing observers
  // (BelongsTo/UIDComponent observers fire during deserialization, updating nameCache)
```

### R13: Entity ID Mapping

Entity IDs are runtime-local (Spec 01, R8). When data crosses network boundaries, entity IDs must be remapped. The ID map is a bidirectional mapping between local entity IDs and network entity IDs.

```typescript
/**
 * Entity ID map — bidirectional mapping between local and remote entity IDs.
 * Used by serialization, snapshot, and the runtime transport pipeline.
 *
 * The forward map (local → remote) is used when sending data.
 * The reverse map (remote → local) is used when receiving data.
 */
interface EntityIdMap {
  /** Local entity ID → remote/network entity ID */
  readonly localToRemote: Map<Entity, Entity>

  /** Remote/network entity ID → local entity ID */
  readonly remoteToLocal: Map<Entity, Entity>

  /**
   * Register a mapping between a local and remote entity ID.
   * Updates both directions.
   *
   * @param localId - The local entity ID
   * @param remoteId - The remote entity ID
   */
  set(localId: Entity, remoteId: Entity): void

  /**
   * Remove a mapping by local ID.
   * Removes from both directions.
   */
  deleteByLocal(localId: Entity): void

  /**
   * Remove a mapping by remote ID.
   * Removes from both directions.
   */
  deleteByRemote(remoteId: Entity): void

  /** Get the remote ID for a local entity, or undefined */
  getRemote(localId: Entity): Entity | undefined

  /** Get the local ID for a remote entity, or undefined */
  getLocal(remoteId: Entity): Entity | undefined
}

/**
 * Create a new empty entity ID map.
 *
 * @returns An EntityIdMap for tracking local ↔ remote mappings
 */
declare function createEntityIdMap(): EntityIdMap
```

#### Pseudocode

```
function createEntityIdMap():
  localToRemote = new Map()
  remoteToLocal = new Map()

  return {
    localToRemote,
    remoteToLocal,
    set(localId, remoteId):
      localToRemote.set(localId, remoteId)
      remoteToLocal.set(remoteId, localId)
    deleteByLocal(localId):
      remoteId = localToRemote.get(localId)
      if remoteId !== undefined:
        remoteToLocal.delete(remoteId)
      localToRemote.delete(localId)
    deleteByRemote(remoteId):
      localId = remoteToLocal.get(remoteId)
      if localId !== undefined:
        localToRemote.delete(localId)
      remoteToLocal.delete(remoteId)
    getRemote(localId):
      return localToRemote.get(localId)
    getLocal(remoteId):
      return remoteToLocal.get(remoteId)
  }
```

---

## Test Specifications

### System Definition Tests

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWorld, destroyWorld } from '../src/world'
import { defineSystem, removeSystem, injectSystem, reorderSystem } from '../src/system'
import type { World, SystemHandle } from '../src/types'

describe('defineSystem', () => {
  let world: World

  beforeEach(() => {
    world = createWorld()
  })

  afterEach(() => {
    destroyWorld(world)
  })

  it('should register a system and return a handle', () => {
    const handle = defineSystem(world, {
      name: 'TestSystem',
      phase: 'Simulation',
      execute: () => {}
    })

    expect(handle.name).toBe('TestSystem')
    expect(handle.phase).toBe('Simulation')
    expect(handle.definition.name).toBe('TestSystem')
  })

  it('should throw on duplicate system name', () => {
    defineSystem(world, {
      name: 'UniqueSystem',
      phase: 'Input',
      execute: () => {}
    })

    expect(() =>
      defineSystem(world, {
        name: 'UniqueSystem',
        phase: 'Render',
        execute: () => {}
      })
    ).toThrow()
  })

  it('should default execution context to main', () => {
    const handle = defineSystem(world, {
      name: 'DefaultContext',
      phase: 'Render',
      execute: () => {}
    })

    expect(handle.definition.context ?? 'main').toBe('main')
  })

  it('should allow systems with only a reactor (no execute)', () => {
    const handle = defineSystem(world, {
      name: 'ReactorOnly',
      phase: 'Simulation',
      reactor: () => {
        // reactive logic
      }
    })

    expect(handle.name).toBe('ReactorOnly')
    expect(handle.definition.execute).toBeUndefined()
    expect(handle.definition.reactor).toBeDefined()
  })

  it('should allow systems with both execute and reactor', () => {
    const handle = defineSystem(world, {
      name: 'HybridSystem',
      phase: 'Simulation',
      execute: () => {},
      reactor: () => {}
    })

    expect(handle.definition.execute).toBeDefined()
    expect(handle.definition.reactor).toBeDefined()
  })
})
```

### System Ordering Tests

```typescript
describe('System Ordering', () => {
  let world: World

  beforeEach(() => {
    world = createWorld()
  })

  afterEach(() => {
    destroyWorld(world)
  })

  it('should respect before/after ordering within a phase', () => {
    const order: string[] = []

    defineSystem(world, {
      name: 'Second',
      phase: 'Simulation',
      after: ['First'],
      execute: () => {
        order.push('Second')
      }
    })

    defineSystem(world, {
      name: 'First',
      phase: 'Simulation',
      execute: () => {
        order.push('First')
      }
    })

    defineSystem(world, {
      name: 'Third',
      phase: 'Simulation',
      after: ['Second'],
      execute: () => {
        order.push('Third')
      }
    })

    // Simulate one Simulation tick
    executeFrame(world, 1.0) // first frame — sets time
    executeFrame(world, 1.0 + world.fixedTimeStep) // triggers one Simulation step

    expect(order).toEqual(['First', 'Second', 'Third'])
  })

  it('should ignore ordering references to systems in other phases', () => {
    const order: string[] = []

    defineSystem(world, {
      name: 'InputSystem',
      phase: 'Input',
      execute: () => {
        order.push('Input')
      }
    })

    defineSystem(world, {
      name: 'RenderSystem',
      phase: 'Render',
      after: ['InputSystem'], // different phase — ignored for ordering
      execute: () => {
        order.push('Render')
      }
    })

    executeFrame(world, 1.0)
    executeFrame(world, 1.016)

    // Input always runs before Render due to phase ordering
    const inputIdx = order.indexOf('Input')
    const renderIdx = order.indexOf('Render')
    expect(inputIdx).toBeLessThan(renderIdx)
  })
})
```

### Phase Execution Tests

```typescript
import { executeFrame } from '../src/frame'

describe('Phase Execution', () => {
  let world: World

  beforeEach(() => {
    world = createWorld()
  })

  afterEach(() => {
    destroyWorld(world)
  })

  it('should execute phases in order: Input → Simulation → Animation → Render', () => {
    const order: string[] = []

    defineSystem(world, { name: 'I', phase: 'Input', execute: () => order.push('Input') })
    defineSystem(world, { name: 'S', phase: 'Simulation', execute: () => order.push('Simulation') })
    defineSystem(world, { name: 'A', phase: 'Animation', execute: () => order.push('Animation') })
    defineSystem(world, { name: 'R', phase: 'Render', execute: () => order.push('Render') })

    executeFrame(world, 1.0) // first frame
    executeFrame(world, 1.0 + world.fixedTimeStep)

    expect(order).toEqual(['Input', 'Simulation', 'Animation', 'Render'])
  })

  it('should run Simulation multiple times when accumulator exceeds fixedTimeStep', () => {
    let simCount = 0

    defineSystem(world, {
      name: 'Sim',
      phase: 'Simulation',
      execute: () => {
        simCount++
      }
    })

    executeFrame(world, 1.0) // first frame — no delta
    // Advance by 3 fixed timesteps worth
    executeFrame(world, 1.0 + world.fixedTimeStep * 3)

    expect(simCount).toBe(3)
  })

  it('should not run Simulation if accumulator is less than fixedTimeStep', () => {
    let simCount = 0

    defineSystem(world, {
      name: 'Sim',
      phase: 'Simulation',
      execute: () => {
        simCount++
      }
    })

    executeFrame(world, 1.0) // first frame
    // Advance by less than one fixed timestep
    executeFrame(world, 1.0 + world.fixedTimeStep * 0.5)

    expect(simCount).toBe(0)
  })

  it('should pass fixedTimeStep to Simulation systems and deltaSeconds to others', () => {
    const deltas: Record<string, number[]> = {
      input: [],
      simulation: [],
      render: []
    }

    defineSystem(world, {
      name: 'I',
      phase: 'Input',
      execute: (_, dt) => deltas.input.push(dt)
    })
    defineSystem(world, {
      name: 'S',
      phase: 'Simulation',
      execute: (_, dt) => deltas.simulation.push(dt)
    })
    defineSystem(world, {
      name: 'R',
      phase: 'Render',
      execute: (_, dt) => deltas.render.push(dt)
    })

    executeFrame(world, 1.0)
    executeFrame(world, 1.0 + world.fixedTimeStep * 2)

    // Simulation should receive fixedTimeStep
    for (const dt of deltas.simulation) {
      expect(dt).toBeCloseTo(world.fixedTimeStep)
    }

    // Input and Render should receive variable deltaSeconds
    for (const dt of deltas.input) {
      expect(dt).toBeCloseTo(world.fixedTimeStep * 2)
    }
    for (const dt of deltas.render) {
      expect(dt).toBeCloseTo(world.fixedTimeStep * 2)
    }
  })
})
```

### System Injection Tests

```typescript
describe('System Injection API', () => {
  let world: World

  beforeEach(() => {
    world = createWorld()
  })

  afterEach(() => {
    destroyWorld(world)
  })

  it('should remove a system and stop executing it', () => {
    let count = 0
    const handle = defineSystem(world, {
      name: 'Removable',
      phase: 'Input',
      execute: () => {
        count++
      }
    })

    executeFrame(world, 1.0)
    executeFrame(world, 1.016)
    expect(count).toBe(1) // first frame has 0 delta, second runs once

    removeSystem(world, handle)

    executeFrame(world, 1.032)
    expect(count).toBe(1) // should not increment after removal
  })

  it('should re-inject a previously removed system', () => {
    let count = 0
    const handle = defineSystem(world, {
      name: 'Reinject',
      phase: 'Input',
      execute: () => {
        count++
      }
    })

    removeSystem(world, handle)
    executeFrame(world, 1.0)
    executeFrame(world, 1.016)
    expect(count).toBe(0)

    injectSystem(world, handle)
    executeFrame(world, 1.032)
    expect(count).toBe(1)
  })

  it('should throw when injecting a system with a name that already exists', () => {
    const handle = defineSystem(world, {
      name: 'Conflict',
      phase: 'Input',
      execute: () => {}
    })

    expect(() => injectSystem(world, handle)).toThrow()
  })

  it('should update ordering via reorderSystem', () => {
    const order: string[] = []

    const a = defineSystem(world, {
      name: 'A',
      phase: 'Input',
      execute: () => order.push('A')
    })

    defineSystem(world, {
      name: 'B',
      phase: 'Input',
      after: ['A'],
      execute: () => order.push('B')
    })

    executeFrame(world, 1.0)
    executeFrame(world, 1.016)
    expect(order).toEqual(['A', 'B'])

    // Reorder: A should now run after B
    order.length = 0
    reorderSystem(world, a, { after: ['B'] })
    executeFrame(world, 1.032)
    expect(order).toEqual(['B', 'A'])
  })
})
```

### Prefab Tests

```typescript
import { definePrefab, instantiatePrefab } from '../src/prefab'
import { defineComponent, setComponent, getComponent, hasComponent, Schema } from '../src/component'
import { createEntity } from '../src/entity'
import { BelongsTo, UIDComponent, getEntityByUID } from '../src/identity'

describe('definePrefab', () => {
  const Transform = defineComponent({
    id: 'TransformPrefab',
    label: 'Transform',
    mutationCategory: 'runtime',
    schema: Schema.Object({
      position: Schema.Vec3(),
      rotation: Schema.Quat(),
      scale: Schema.Vec3({ default: [1, 1, 1] })
    })
  })

  const Health = defineComponent({
    id: 'HealthPrefab',
    label: 'Health',
    schema: Schema.Object({
      current: Schema.Number({ default: 100 }),
      max: Schema.Number({ default: 100 })
    })
  })

  it('should create a prefab with composed schema', () => {
    const prefab = definePrefab('TestAvatar', {
      components: [Transform, Health]
    })

    expect(prefab.name).toBe('TestAvatar')
    expect(prefab.components).toHaveLength(2)
    expect(prefab.composedSchema).toBeDefined()
    expect(prefab.composedSchema.componentIds).toContain('TransformPrefab')
    expect(prefab.composedSchema.componentIds).toContain('HealthPrefab')
  })

  it('should track mutation categories per component', () => {
    const prefab = definePrefab('MixedPrefab', {
      components: [Transform, Health]
    })

    expect(prefab.composedSchema.mutationCategories['TransformPrefab']).toBe('runtime')
    expect(prefab.composedSchema.mutationCategories['HealthPrefab']).toBe('authored')
  })

  it('should merge prefab-level defaults over component-level defaults', () => {
    const prefab = definePrefab('DefaultsPrefab', {
      components: [Health],
      defaults: {
        HealthPrefab: { current: 50, max: 200 }
      }
    })

    expect(prefab.defaults['HealthPrefab']).toEqual(expect.objectContaining({ current: 50, max: 200 }))
  })

  it('should throw on duplicate prefab name', () => {
    definePrefab('UniquePrefab', { components: [Health] })

    expect(() =>
      definePrefab('UniquePrefab', {
        components: [Transform]
      })
    ).toThrow()
  })
})

describe('instantiatePrefab', () => {
  const Transform = defineComponent({
    id: 'TransformInst',
    label: 'Transform',
    mutationCategory: 'runtime',
    schema: Schema.Object({
      position: Schema.Vec3()
    })
  })

  const Health = defineComponent({
    id: 'HealthInst',
    label: 'Health',
    schema: Schema.Object({
      current: Schema.Number({ default: 100 }),
      max: Schema.Number({ default: 100 })
    })
  })

  const prefab = definePrefab('InstPrefab', {
    components: [Transform, Health],
    defaults: {
      HealthInst: { current: 80 }
    }
  })

  it('should create an entity with all prefab components', () => {
    const world = createWorld()

    const entity = instantiatePrefab(world, prefab)

    expect(hasComponent(world, entity, Transform)).toBe(true)
    expect(hasComponent(world, entity, Health)).toBe(true)

    destroyWorld(world)
  })

  it('should apply prefab defaults', () => {
    const world = createWorld()

    const entity = instantiatePrefab(world, prefab)

    const health = getComponent(world, entity, Health)
    expect(health!.current).toBe(80) // prefab default
    expect(health!.max).toBe(100) // component schema default

    destroyWorld(world)
  })

  it('should apply caller overrides over prefab defaults', () => {
    const world = createWorld()

    const entity = instantiatePrefab(world, prefab, {
      HealthInst: { current: 25 }
    })

    const health = getComponent(world, entity, Health)
    expect(health!.current).toBe(25) // caller override
    expect(health!.max).toBe(100) // untouched

    destroyWorld(world)
  })

  it('should set identity when uid and parent are provided', () => {
    const world = createWorld()
    const scene = createEntity(world)
    setComponent(world, scene, UIDComponent, { value: 'MainScene' })

    const entity = instantiatePrefab(
      world,
      prefab,
      {},
      {
        uid: 'Player1',
        parent: scene
      }
    )

    expect(hasComponent(world, entity, UIDComponent)).toBe(true)
    const uid = getComponent(world, entity, UIDComponent)
    expect(uid!.value).toBe('Player1')

    const resolved = getEntityByUID(world, scene, 'Player1')
    expect(resolved).toBe(entity)

    destroyWorld(world)
  })

  it('should register composed schema with world network schemas', () => {
    const world = createWorld()

    instantiatePrefab(world, prefab)

    expect(world.network.schemas.has('InstPrefab')).toBe(true)

    destroyWorld(world)
  })
})
```

### Serialization Tests

```typescript
import {
  serializeComponentToJSON,
  deserializeComponentFromJSON,
  createRuntimeSerializer,
  createRuntimeDeserializer
} from '../src/serialization'

describe('Component ↔ JSON Serialization', () => {
  const Health = defineComponent({
    id: 'HealthJSON',
    label: 'Health',
    schema: Schema.Object({
      current: Schema.Number({ default: 100 }),
      max: Schema.Number({ default: 100 })
    })
  })

  const Transform = defineComponent({
    id: 'TransformJSON',
    label: 'Transform',
    mutationCategory: 'runtime',
    schema: Schema.Object({
      position: Schema.Vec3(),
      rotation: Schema.Quat()
    })
  })

  it('should serialize instance-stored component to JSON', () => {
    const world = createWorld()
    const entity = createEntity(world)
    setComponent(world, entity, Health, { current: 75, max: 100 })

    const json = serializeComponentToJSON(world, entity, Health)

    expect(json).toBeDefined()
    expect(json!.current).toBe(75)
    expect(json!.max).toBe(100)

    destroyWorld(world)
  })

  it('should serialize SoA-stored component to JSON with value arrays', () => {
    const world = createWorld()
    const entity = createEntity(world)
    setComponent(world, entity, Transform, {
      position: [10, 20, 30],
      rotation: [0, 0, 0, 1]
    })

    const json = serializeComponentToJSON(world, entity, Transform)

    expect(json).toBeDefined()
    expect(json!.position).toEqual([10, 20, 30])
    expect(json!.rotation).toEqual([0, 0, 0, 1])

    destroyWorld(world)
  })

  it('should return undefined for entities without the component', () => {
    const world = createWorld()
    const entity = createEntity(world)

    const json = serializeComponentToJSON(world, entity, Health)
    expect(json).toBeUndefined()

    destroyWorld(world)
  })

  it('should deserialize JSON back into component data', () => {
    const world = createWorld()
    const entity = createEntity(world)

    deserializeComponentFromJSON(world, entity, Health, { current: 42, max: 200 })

    const data = getComponent(world, entity, Health)
    expect(data!.current).toBe(42)
    expect(data!.max).toBe(200)

    destroyWorld(world)
  })

  it('should round-trip: serialize → deserialize preserves data', () => {
    const world = createWorld()
    const e1 = createEntity(world)
    setComponent(world, e1, Transform, {
      position: [1.5, 2.5, 3.5],
      rotation: [0.1, 0.2, 0.3, 0.9]
    })

    const json = serializeComponentToJSON(world, e1, Transform)!
    const e2 = createEntity(world)
    deserializeComponentFromJSON(world, e2, Transform, json)

    const data = getComponent(world, e2, Transform)
    expect(data!.position).toEqual(json.position)
    expect(data!.rotation).toEqual(json.rotation)

    destroyWorld(world)
  })
})

describe('SoA ↔ Binary Serialization', () => {
  const Transform = defineComponent({
    id: 'TransformBinary',
    label: 'Transform',
    mutationCategory: 'runtime',
    schema: Schema.Object({
      position: Schema.Vec3()
    })
  })

  it('should serialize and deserialize runtime data to binary', () => {
    const world = createWorld()
    const entity = createEntity(world)
    setComponent(world, entity, Transform, { position: [10, 20, 30] })

    const serialize = createRuntimeSerializer([Transform])
    const buffer = serialize(world, [entity])

    expect(buffer).toBeInstanceOf(ArrayBuffer)
    expect(buffer.byteLength).toBeGreaterThan(0)

    // Create a second world and deserialize into it
    const world2 = createWorld()
    const entity2 = createEntity(world2)
    setComponent(world2, entity2, Transform) // add component with defaults

    const idMap = new Map<number, number>([[entity, entity2]])
    const deserialize = createRuntimeDeserializer([Transform])
    deserialize(world2, buffer, idMap)

    expect(Transform.$soaStore.position.x[entity2]).toBeCloseTo(10)
    expect(Transform.$soaStore.position.y[entity2]).toBeCloseTo(20)
    expect(Transform.$soaStore.position.z[entity2]).toBeCloseTo(30)

    destroyWorld(world)
    destroyWorld(world2)
  })
})
```

### Snapshot Tests

```typescript
import { createSnapshot, applySnapshot } from '../src/snapshot'

describe('Snapshot', () => {
  const Transform = defineComponent({
    id: 'TransformSnap',
    label: 'Transform',
    mutationCategory: 'runtime',
    schema: Schema.Object({
      position: Schema.Vec3()
    })
  })

  const Health = defineComponent({
    id: 'HealthSnap',
    label: 'Health',
    schema: Schema.Object({
      current: Schema.Number({ default: 100 }),
      max: Schema.Number({ default: 100 })
    })
  })

  it('should create a full world snapshot', () => {
    const world = createWorld()
    const e1 = createEntity(world)
    const e2 = createEntity(world)
    setComponent(world, e1, Transform, { position: [1, 2, 3] })
    setComponent(world, e1, Health, { current: 50, max: 100 })
    setComponent(world, e2, Health, { current: 75, max: 100 })

    const snap = createSnapshot(world)

    expect(snap.data).toBeInstanceOf(ArrayBuffer)
    expect(snap.data.byteLength).toBeGreaterThan(0)
    expect(snap.metadata.entityCount).toBe(2)
    expect(snap.metadata.components).toContain('TransformSnap')
    expect(snap.metadata.components).toContain('HealthSnap')

    destroyWorld(world)
  })

  it('should create a filtered snapshot', () => {
    const world = createWorld()
    const e1 = createEntity(world)
    const e2 = createEntity(world)
    setComponent(world, e1, Transform, { position: [1, 2, 3] })
    setComponent(world, e1, Health, { current: 50, max: 100 })
    setComponent(world, e2, Health, { current: 75, max: 100 })

    const snap = createSnapshot(world, { filter: [Transform] })

    // Only e1 has Transform
    expect(snap.metadata.entityCount).toBe(1)

    destroyWorld(world)
  })

  it('should apply a snapshot to an empty world', () => {
    const world1 = createWorld()
    const e1 = createEntity(world1)
    setComponent(world1, e1, Health, { current: 42, max: 100 })

    const snap = createSnapshot(world1)

    const world2 = createWorld()
    const idMap = new Map<number, number>()
    applySnapshot(world2, snap, { idMap })

    // A new entity should exist in world2 with the same data
    expect(idMap.size).toBeGreaterThan(0)

    // Get the local entity for e1
    const localEntity = idMap.get(e1)!
    expect(localEntity).toBeDefined()
    const data = getComponent(world2, localEntity, Health)
    expect(data!.current).toBe(42)

    destroyWorld(world1)
    destroyWorld(world2)
  })

  it('should apply a snapshot with merge mode', () => {
    const world = createWorld()
    const existing = createEntity(world)
    setComponent(world, existing, Health, { current: 100, max: 100 })

    // Create a snapshot from another world
    const world2 = createWorld()
    const e2 = createEntity(world2)
    setComponent(world2, e2, Health, { current: 50, max: 100 })
    const snap = createSnapshot(world2)

    // Apply with merge — existing entities should not be removed
    applySnapshot(world, snap, { merge: true })

    // Original entity should still exist
    expect(hasComponent(world, existing, Health)).toBe(true)

    destroyWorld(world)
    destroyWorld(world2)
  })

  it('should include simulation time in metadata', () => {
    const world = createWorld()
    world.simulationTime = 42.5

    const snap = createSnapshot(world)

    expect(snap.metadata.simulationTime).toBe(42.5)

    destroyWorld(world)
  })
})
```

### Entity ID Map Tests

```typescript
import { createEntityIdMap } from '../src/serialization'

describe('EntityIdMap', () => {
  it('should create an empty bidirectional map', () => {
    const map = createEntityIdMap()

    expect(map.localToRemote.size).toBe(0)
    expect(map.remoteToLocal.size).toBe(0)
  })

  it('should set and get mappings in both directions', () => {
    const map = createEntityIdMap()

    map.set(1, 100)
    map.set(2, 200)

    expect(map.getRemote(1)).toBe(100)
    expect(map.getRemote(2)).toBe(200)
    expect(map.getLocal(100)).toBe(1)
    expect(map.getLocal(200)).toBe(2)
  })

  it('should delete by local ID in both directions', () => {
    const map = createEntityIdMap()
    map.set(1, 100)

    map.deleteByLocal(1)

    expect(map.getRemote(1)).toBeUndefined()
    expect(map.getLocal(100)).toBeUndefined()
  })

  it('should delete by remote ID in both directions', () => {
    const map = createEntityIdMap()
    map.set(1, 100)

    map.deleteByRemote(100)

    expect(map.getRemote(1)).toBeUndefined()
    expect(map.getLocal(100)).toBeUndefined()
  })

  it('should return undefined for unmapped IDs', () => {
    const map = createEntityIdMap()

    expect(map.getRemote(999)).toBeUndefined()
    expect(map.getLocal(999)).toBeUndefined()
  })

  it('should handle overwriting an existing mapping', () => {
    const map = createEntityIdMap()
    map.set(1, 100)
    map.set(1, 200) // overwrite

    expect(map.getRemote(1)).toBe(200)
    expect(map.getLocal(200)).toBe(1)
    // Old remote mapping should be cleaned up
    expect(map.getLocal(100)).toBeUndefined()
  })
})
```

---

## Edge Cases & Constraints

1. **System names must be unique per world.** `defineSystem` with a duplicate name in the same world must throw. Different worlds can have systems with the same name.

2. **Circular ordering dependencies must be detected.** If system A declares `after: ['B']` and system B declares `after: ['A']`, `defineSystem` (or `reorderSystem`) must throw with a clear error.

3. **Cross-phase ordering is ignored.** `before`/`after` references to systems in different phases are silently ignored — phase ordering is always Input → Simulation → Animation → Render regardless of system-level declarations.

4. **Simulation phase spiral-of-death.** The accumulator clamp in `updateWorldTime` (Spec 01) prevents unbounded Simulation iterations. Even so, if Simulation systems are too slow, the accumulator can grow and produce multiple iterations per frame until the clamp kicks in.

5. **Reactor lifecycle.** Reactors are mounted once via `createRoot` on `defineSystem`/`injectSystem` and disposed on `removeSystem`. Re-injecting a system creates a new reactive root — it does NOT resume the old one.

6. **Prefab names must be globally unique.** `definePrefab` with a duplicate name must throw.

7. **Prefab component ordering.** Components are added to an entity in the order they appear in `prefab.components`. If component B's observer depends on component A being present, A must appear before B in the array.

8. **Snapshot size.** Full-world snapshots can be large. Callers should use `filter` for partial snapshots when appropriate (e.g., zone-specific snapshots for spatial partitioning).

9. **Entity ID map must handle stale entries.** When an entity is removed from either side (local or remote), its entry in the ID map must be cleaned up to prevent stale references.

10. **Snapshot does not capture systems or transport state.** A snapshot captures entity/component/relationship data only. System registrations, reactor state, transport configuration, and connection state are NOT included.

11. **Serialization of local-category components.** `serializeComponentToJSON` works with any component regardless of mutation category. However, `createRuntimeSerializer` should only be used with runtime-category components. Calling it with authored or local components is a logic error (but not a runtime error — it will produce a buffer, just one that shouldn't be sent over the wire).

---

## Dependencies

- **Spec 01 (`01-world-entity.md`)**: World, Entity, `updateWorldTime`, time state fields (accumulator, fixedTimeStep, deltaSeconds, simulationTime)
- **Spec 02 (`02-component-definitions.md`)**: `defineComponent`, `setComponent`, `getComponent`, `hasComponent`, `removeComponent`, `ComponentDefinition`, `ComponentSchema`, `Schema`, `MutationCategory`, observers
- **Spec 03 (`03-relations-identity.md`)**: `defineRelation`, `addRelation`, `BelongsTo`, `UIDComponent`, `getEntityByUID`, identity path resolution
- **bitECS v4**: `query`, `createSoASerializer`, `createSoADeserializer`, `createSnapshotSerializer`, `createSnapshotDeserializer`
- **SolidJS** (DOMless): `createRoot`, `createSignal`, `createEffect`, `createMemo` — for reactor logic
- **TypeBox** (`@sinclair/typebox`): JSON Schema generation for composed schemas
