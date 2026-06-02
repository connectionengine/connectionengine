# Spec 01: World & Entity Foundations

## Project & Architecture Context

**Connection Engine** is a semantic spatial web engine — a multiplayer-first, data-driven TypeScript engine for real-time spatial experiences built on web standards.

**Core design principles:**

1. **Everything is an entity.** Users, avatars, scores, quests, factions, inventories — only engine runtime bindings live outside the ECS.
2. **Fewest abstractions.** One ECS/change model serves realtime replication, authority, validation, and persistence integrations.
3. **Component-level mutation categories.** Network behaviour is defined per-component as authored (reliable, governance-validated, event-sourced), runtime (binary, authority-checked, ephemeral), or local (never replicated).
4. **Semantic graph runtime.** The ECS is a graph of typed relationships — components are schemas, relationships are predicates, queries are pattern matching.

**Tech stack:** TypeScript, bitECS v4, TypeBox, Vitest

**Dependency chain:** This is Spec 01 (Tier 0) — the foundational layer with no dependencies. All other specs depend on this one:

- → `02-component-definitions.md` depends on World and Entity
- → `03-relations-identity.md` depends on World and Entity
- → `04-systems-prefabs-serialization.md` depends transitively
- → `05-mutation-pipeline.md` depends transitively
- → `06-users-peers-authority.md` depends transitively
- → `07-governance.md` depends transitively

---

## Scope & Intent

This spec defines the two most fundamental primitives in Connection Engine:

1. **World** — the top-level container for all ECS state. Holds entities, component/relation registries, systems, connection state, time tracking, and schema metadata. Multiple worlds can coexist independently.

2. **Entity** — an integer ID representing any thing in the engine. Has no data of its own; all state lives in components and relationships (defined in later specs).

This spec covers creation, destruction, isolation guarantees, and the time management loop. It does NOT cover components, relationships, identity, networking, or systems — those are layered on in subsequent specs.

---

## Requirements

### R1: World Creation

A World is the top-level ECS + Network container. It wraps a bitECS world and adds Connection Engine's time state, realtime bindings, and entity identity caches.

#### Interfaces

```typescript
import type { World as BitECSWorld } from 'bitecs'

/**
 * Identifier type for entities — always a number (bitECS entity ID).
 * Runtime-local, never networked directly.
 */
type Entity = number

/**
 * Realtime bindings — how the world tracks live peer replication state.
 * Populated by higher-layer networking (Spec 05).
 */
interface RealtimeBindings {
  /** Active peer connections for this world/session */
  connections: Set<Connection>
  /** Schema registry — component id → generated ComponentSchema */
  schemas: Map<string, ComponentSchema>
}

/**
 * Forward declaration — fully defined in Spec 05 (05-mutation-pipeline.md).
 * A live transport link to a peer.
 */
interface Connection {
  peer: Entity
  backend: TransportBackend
  metadata?: Record<string, unknown>
}

/** Transport backend type — fully defined in Spec 05. */
type TransportBackend = 'webrtc' | 'websocket'

/**
 * Forward declaration — fully defined in Spec 02 (02-component-definitions.md).
 * Shareable schema metadata produced from a component definition.
 */
interface ComponentSchema {
  readonly jsonSchema: object
  readonly shaclShape: object
  readonly mutationCategory: 'authored' | 'runtime' | 'local'
}

/**
 * The top-level ECS + Network container.
 * Extends bitECS's World with engine-specific bindings.
 */
interface World extends BitECSWorld {
  // ---- Time State ----

  /** Wall-clock time of the current frame (ms since epoch or performance.now) */
  frameTime: number

  /** Accumulated simulation time (seconds), advances in fixedTimeStep increments */
  simulationTime: number

  /** Fixed timestep for Simulation phase (seconds, default: 1/60) */
  fixedTimeStep: number

  /** Time elapsed since last frame (seconds, variable) */
  deltaSeconds: number

  /** Accumulator for fixed timestep — carries leftover time between frames */
  accumulator: number

  // ---- Realtime Bindings ----

  /** Network state for this world's live session */
  network: RealtimeBindings

  // ---- Entity Identity Caches ----

  /**
   * O(1) entity lookup cache: parent entity → (uid string → child entity).
   * Maintained by observers on BelongsTo + UIDComponent (see Spec 03).
   * Initialised as empty here; populated when identity components are used.
   */
  nameCache: Map<Entity, Map<string, Entity>>
}
```

#### Options

```typescript
/** Options for creating a new Connection Engine world. */
interface CreateWorldOptions {
  /**
   * Fixed timestep for Simulation phase, in seconds.
   * @default 1/60 (≈0.01667)
   */
  fixedTimeStep?: number
}
```

#### Function Signature

```typescript
/**
 * Create a new Connection Engine world.
 *
 * Wraps bitECS `createWorld()` and initialises:
 * - Time state (frameTime, simulationTime, deltaSeconds, accumulator all zeroed)
 * - fixedTimeStep from options or default 1/60
 * - Empty RealtimeBindings (connections Set, schemas Map)
 * - Empty nameCache Map
 * - Registers the world in the global `worlds` Set
 *
 * @param options - Optional configuration
 * @returns A fully initialised World
 */
declare function createWorld(options?: CreateWorldOptions): World
```

#### Pseudocode

```
function createWorld(options?):
  world = bitecs.createWorld() as World

  // Time state
  world.frameTime = 0
  world.simulationTime = 0
  world.fixedTimeStep = options?.fixedTimeStep ?? 1/60
  world.deltaSeconds = 0
  world.accumulator = 0

  // Realtime bindings
  world.network = {
    connections: new Set(),
    schemas: new Map(),
  }

  // Entity identity cache
  world.nameCache = new Map()

  // Global registry
  worlds.add(world)

  return world
```

### R2: World Destruction

```typescript
/**
 * Destroy a world, cleaning up all state.
 *
 * Performs in order:
 * 1. Remove all entities (triggering component/relationship cleanup via bitECS)
 * 2. Clear all connections in network.connections
 * 3. Clear network.schemas
 * 4. Clear nameCache
 * 5. Remove from global `worlds` Set
 * 6. Call bitECS deleteWorld if available
 *
 * After destruction, the world reference must not be reused.
 *
 * @param world - The world to destroy
 */
declare function destroyWorld(world: World): void
```

#### Pseudocode

```
function destroyWorld(world):
  // Remove all entities — bitECS handles component cleanup
  for entity in getAllEntities(world):
    bitecs.removeEntity(world, entity)

  // Clear network state
  world.network.connections.clear()
  world.network.schemas.clear()

  // Clear identity cache
  world.nameCache.clear()

  // Unregister globally
  worlds.delete(world)

  // bitECS cleanup
  bitecs.deleteWorld(world)
```

### R3: Global World Registry

A module-level `Set<World>` tracks all active worlds. This enables iteration over all worlds (e.g., for debug tooling) and ensures cleanup on destruction.

```typescript
/**
 * Module-level set of all active worlds.
 * Worlds are added on createWorld() and removed on destroyWorld().
 */
const worlds: ReadonlySet<World>

/**
 * Get all currently active worlds.
 * @returns A read-only view of the global worlds set
 */
declare function getWorlds(): ReadonlySet<World>
```

### R4: World Isolation

Multiple worlds MUST coexist independently. Entities, components, relationships, systems, and network state in one world MUST NOT affect any other world. This enables patterns like:

- Lobby world + game world running simultaneously
- Test worlds in unit tests
- Editor preview world alongside the main world

### R5: Time State Management

Time state fields on World are updated externally by the frame loop (defined in Spec 04 — Systems). This spec only defines the fields and their semantics.

```typescript
/**
 * Update the world's time state for a new frame.
 *
 * Called once per frame by the engine's main loop (before system execution).
 * Computes deltaSeconds from the difference between the new frameTime and the
 * previous frameTime. Clamps deltaSeconds to prevent spiral-of-death.
 *
 * @param world - The world to update
 * @param currentTime - Current time in seconds (e.g., performance.now() / 1000)
 * @param maxDelta - Maximum allowed deltaSeconds to prevent spiral-of-death (default: 0.25)
 */
declare function updateWorldTime(world: World, currentTime: number, maxDelta?: number): void
```

#### Pseudocode

```
function updateWorldTime(world, currentTime, maxDelta = 0.25):
  if world.frameTime === 0:
    // First frame — no delta
    world.frameTime = currentTime
    world.deltaSeconds = 0
    return

  rawDelta = currentTime - world.frameTime
  world.deltaSeconds = Math.min(rawDelta, maxDelta)  // clamp to prevent spiral-of-death
  world.frameTime = currentTime
  world.accumulator += world.deltaSeconds
```

**Accumulator consumption** happens in the Simulation phase (Spec 04):

```
while world.accumulator >= world.fixedTimeStep:
  // run simulation systems at fixedTimeStep
  world.simulationTime += world.fixedTimeStep
  world.accumulator -= world.fixedTimeStep
```

### R6: Entity Creation

An Entity is an integer ID — it has no inherent data. All state is in components and relationships (Spec 02, 03). Entity IDs are runtime-local to their world and are NEVER sent over the network.

```typescript
/**
 * Create a new entity in a world.
 *
 * Wraps bitECS `addEntity()`. The returned entity ID is an integer
 * that is local to this runtime — it must never be used as a network identifier.
 *
 * Identity (UID, parent context) is handled by Spec 03 via UIDComponent + BelongsTo.
 * This function intentionally does NOT accept uid/parent options — those are
 * set via setComponent/addRelation after creation (Spec 02, 03).
 *
 * @param world - The world to create the entity in
 * @returns The new entity ID (a number, local to this runtime)
 */
declare function createEntity(world: World): Entity
```

#### Pseudocode

```
function createEntity(world):
  entity = bitecs.addEntity(world)
  return entity
```

### R7: Entity Destruction

```typescript
/**
 * Remove an entity from a world.
 *
 * Wraps bitECS `removeEntity()`. bitECS handles:
 * - Removing all components from the entity
 * - Triggering onRemove observers for each component
 * - Cleaning up relationship pairs (cascade behaviour per relation modifiers)
 * - Recycling the entity ID for future use
 *
 * Higher-layer concerns (replication mutations, identity cache cleanup)
 * are handled by observers registered in Spec 02, 03, and 05.
 *
 * @param world - The world the entity belongs to
 * @param entity - The entity to remove
 */
declare function removeEntity(world: World, entity: Entity): void
```

#### Pseudocode

```
function removeEntity(world, entity):
  // bitECS handles all component/relationship cleanup and observer firing
  bitecs.removeEntity(world, entity)
```

### R8: Entity ID Properties

- Entity IDs are non-negative integers (bitECS guarantees this)
- Entity IDs are recycled by bitECS after removal — a removed entity's ID may be reused for a new entity
- Entity IDs are world-local — the same integer in two different worlds refers to different entities
- Entity IDs are runtime-local — the same logical entity on two different peers will have different integer IDs
- Entity ID 0 is reserved by bitECS as "no entity" / invalid

---

## Test Specifications

### World Creation Tests

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { createWorld, destroyWorld, getWorlds } from '../src/world'
import type { World } from '../src/world'

describe('World Creation', () => {
  it('should create a world with default time state', () => {
    const world = createWorld()

    expect(world.frameTime).toBe(0)
    expect(world.simulationTime).toBe(0)
    expect(world.deltaSeconds).toBe(0)
    expect(world.accumulator).toBe(0)
    expect(world.fixedTimeStep).toBeCloseTo(1 / 60)

    destroyWorld(world)
  })

  it('should create a world with custom fixedTimeStep', () => {
    const world = createWorld({ fixedTimeStep: 1 / 30 })

    expect(world.fixedTimeStep).toBeCloseTo(1 / 30)

    destroyWorld(world)
  })

  it('should initialise empty realtime bindings', () => {
    const world = createWorld()

    expect(world.network.connections).toBeInstanceOf(Set)
    expect(world.network.connections.size).toBe(0)
    expect(world.network.schemas).toBeInstanceOf(Map)
    expect(world.network.schemas.size).toBe(0)

    destroyWorld(world)
  })

  it('should initialise empty nameCache', () => {
    const world = createWorld()

    expect(world.nameCache).toBeInstanceOf(Map)
    expect(world.nameCache.size).toBe(0)

    destroyWorld(world)
  })

  it('should register the world in the global worlds set', () => {
    const world = createWorld()

    expect(getWorlds().has(world)).toBe(true)

    destroyWorld(world)
  })
})
```

### World Destruction Tests

```typescript
describe('World Destruction', () => {
  it('should remove the world from the global worlds set', () => {
    const world = createWorld()
    expect(getWorlds().has(world)).toBe(true)

    destroyWorld(world)
    expect(getWorlds().has(world)).toBe(false)
  })

  it('should clear network connections', () => {
    const world = createWorld()
    // Simulate a connection existing (normally done by networking layer)
    world.network.connections.add({ peer: 1, backend: 'webrtc' } as any)
    expect(world.network.connections.size).toBe(1)

    destroyWorld(world)
    expect(world.network.connections.size).toBe(0)
  })

  it('should clear network schemas', () => {
    const world = createWorld()
    world.network.schemas.set('test', {} as any)
    expect(world.network.schemas.size).toBe(1)

    destroyWorld(world)
    expect(world.network.schemas.size).toBe(0)
  })

  it('should clear nameCache', () => {
    const world = createWorld()
    world.nameCache.set(1, new Map([['test', 2]]))
    expect(world.nameCache.size).toBe(1)

    destroyWorld(world)
    expect(world.nameCache.size).toBe(0)
  })

  it('should remove all entities from the world', () => {
    const world = createWorld()
    const e1 = createEntity(world)
    const e2 = createEntity(world)
    const e3 = createEntity(world)

    destroyWorld(world)
    // After destruction, we cannot query entities — the world is invalid
    // This test primarily ensures destroyWorld does not throw
  })
})
```

### World Isolation Tests

```typescript
describe('World Isolation', () => {
  it('should maintain independent entity ID spaces', () => {
    const world1 = createWorld()
    const world2 = createWorld()

    const e1 = createEntity(world1)
    const e2 = createEntity(world2)

    // Both worlds can produce the same integer ID — they are independent
    // The key assertion is that operations on one world don't affect the other
    expect(e1).toBeTypeOf('number')
    expect(e2).toBeTypeOf('number')

    destroyWorld(world1)
    destroyWorld(world2)
  })

  it('should allow multiple worlds to coexist', () => {
    const worlds: World[] = []
    for (let i = 0; i < 5; i++) {
      worlds.push(createWorld())
    }

    expect(getWorlds().size).toBeGreaterThanOrEqual(5)

    // Create entities in each world independently
    const entities = worlds.map((w) => createEntity(w))
    expect(entities).toHaveLength(5)
    entities.forEach((e) => expect(e).toBeTypeOf('number'))

    // Destroy one world — others are unaffected
    destroyWorld(worlds[2])
    expect(getWorlds().has(worlds[2])).toBe(false)
    expect(getWorlds().has(worlds[0])).toBe(true)
    expect(getWorlds().has(worlds[4])).toBe(true)

    // Clean up remaining
    worlds.forEach((w, i) => {
      if (i !== 2) destroyWorld(w)
    })
  })

  it('should have independent time state per world', () => {
    const world1 = createWorld({ fixedTimeStep: 1 / 60 })
    const world2 = createWorld({ fixedTimeStep: 1 / 30 })

    updateWorldTime(world1, 1.0)
    expect(world1.deltaSeconds).toBeGreaterThan(0)
    expect(world2.deltaSeconds).toBe(0) // world2 not updated

    destroyWorld(world1)
    destroyWorld(world2)
  })

  it('should have independent network state per world', () => {
    const world1 = createWorld()
    const world2 = createWorld()

    world1.network.schemas.set('Transform', {} as any)
    expect(world1.network.schemas.size).toBe(1)
    expect(world2.network.schemas.size).toBe(0)

    destroyWorld(world1)
    destroyWorld(world2)
  })
})
```

### Time State Tests

```typescript
import { updateWorldTime } from '../src/world'

describe('Time State Management', () => {
  it('should handle first frame with zero delta', () => {
    const world = createWorld()

    updateWorldTime(world, 1.0)

    expect(world.frameTime).toBe(1.0)
    expect(world.deltaSeconds).toBe(0)
    expect(world.accumulator).toBe(0)

    destroyWorld(world)
  })

  it('should compute deltaSeconds from frame time difference', () => {
    const world = createWorld()

    updateWorldTime(world, 1.0) // first frame
    updateWorldTime(world, 1.016) // ~16ms later

    expect(world.frameTime).toBe(1.016)
    expect(world.deltaSeconds).toBeCloseTo(0.016)
    expect(world.accumulator).toBeCloseTo(0.016)

    destroyWorld(world)
  })

  it('should accumulate time across frames', () => {
    const world = createWorld()

    updateWorldTime(world, 1.0)
    updateWorldTime(world, 1.016)
    updateWorldTime(world, 1.032)

    expect(world.accumulator).toBeCloseTo(0.032)

    destroyWorld(world)
  })

  it('should clamp deltaSeconds to maxDelta to prevent spiral-of-death', () => {
    const world = createWorld()

    updateWorldTime(world, 1.0)
    // Simulate a 2-second pause (e.g., tab was backgrounded)
    updateWorldTime(world, 3.0)

    // Default maxDelta is 0.25
    expect(world.deltaSeconds).toBe(0.25)
    expect(world.accumulator).toBeCloseTo(0.25)

    destroyWorld(world)
  })

  it('should respect custom maxDelta', () => {
    const world = createWorld()

    updateWorldTime(world, 1.0)
    updateWorldTime(world, 3.0, 0.5)

    expect(world.deltaSeconds).toBe(0.5)

    destroyWorld(world)
  })

  it('should not modify simulationTime (that is done by the Simulation phase)', () => {
    const world = createWorld()

    updateWorldTime(world, 1.0)
    updateWorldTime(world, 1.5)

    expect(world.simulationTime).toBe(0)

    destroyWorld(world)
  })
})
```

### Entity Creation Tests

```typescript
import { createEntity, removeEntity } from '../src/entity'

describe('Entity Creation', () => {
  it('should create an entity as a number', () => {
    const world = createWorld()

    const entity = createEntity(world)

    expect(entity).toBeTypeOf('number')
    expect(entity).toBeGreaterThan(0) // entity 0 is reserved

    destroyWorld(world)
  })

  it('should create unique entity IDs within a world', () => {
    const world = createWorld()

    const e1 = createEntity(world)
    const e2 = createEntity(world)
    const e3 = createEntity(world)

    expect(e1).not.toBe(e2)
    expect(e2).not.toBe(e3)
    expect(e1).not.toBe(e3)

    destroyWorld(world)
  })

  it('should create many entities without error', () => {
    const world = createWorld()

    const entities: Entity[] = []
    for (let i = 0; i < 1000; i++) {
      entities.push(createEntity(world))
    }

    expect(entities).toHaveLength(1000)
    const unique = new Set(entities)
    expect(unique.size).toBe(1000)

    destroyWorld(world)
  })
})
```

### Entity Destruction Tests

```typescript
describe('Entity Destruction', () => {
  it('should remove an entity without error', () => {
    const world = createWorld()
    const entity = createEntity(world)

    expect(() => removeEntity(world, entity)).not.toThrow()

    destroyWorld(world)
  })

  it('should allow entity ID recycling after removal', () => {
    const world = createWorld()

    const e1 = createEntity(world)
    removeEntity(world, e1)

    // bitECS may recycle the ID — create another entity and it might
    // reuse the same integer. This is expected behaviour.
    const e2 = createEntity(world)
    expect(e2).toBeTypeOf('number')
    expect(e2).toBeGreaterThan(0)

    destroyWorld(world)
  })
})
```

---

## Edge Cases & Constraints

1. **Entity ID 0 is invalid.** Entity 0 is reserved by bitECS. `createEntity` must never return 0. Code should treat 0 as "no entity."

2. **Entity IDs must never be networked directly.** They are runtime-local integers. The identity system (Spec 03: BelongsTo + UIDComponent) provides network-safe addressing.

3. **World must not be used after destruction.** Calling any function with a destroyed world is undefined behaviour. The implementation may choose to throw or silently fail.

4. **Spiral-of-death protection.** `updateWorldTime` MUST clamp deltaSeconds. Without clamping, a single slow frame causes the accumulator to grow, which causes more simulation steps, which causes the next frame to be even slower — a positive feedback loop.

5. **Multiple worlds must not share state.** Each world has its own bitECS world, its own entity ID space, its own network bindings, and its own nameCache. There is no cross-world entity reference.

6. **Entity IDs are recycled.** After `removeEntity`, the same integer ID may be assigned to a future `createEntity` call. Code must not hold stale entity references across removal boundaries without checking validity.

7. **Time units.** `frameTime` and `currentTime` are in seconds (not milliseconds). Callers using `performance.now()` must divide by 1000.

---

## Dependencies

This spec has no dependencies on other specs. It uses only:

- **bitECS v4**: `createWorld`, `deleteWorld`, `addEntity`, `removeEntity`
- **TypeScript**: standard types

All other specs build on the World and Entity types defined here.
