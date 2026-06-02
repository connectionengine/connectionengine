# Spec 03: Relations & Entity Identity

## Project & Architecture Context

**Connection Engine** is a semantic spatial web engine — a multiplayer-first, data-driven TypeScript engine for real-time spatial experiences built on web standards.

**Core design principles:**

1. **Everything is an entity.** Users, avatars, scores, quests, factions, inventories — only engine runtime bindings live outside the ECS.
2. **Fewest abstractions.** One ECS/change model serves realtime replication, authority, validation, and persistence integrations.
3. **Component-level mutation categories.** Network behaviour is defined per-component as authored (reliable, governance-validated, event-sourced), runtime (binary, authority-checked, ephemeral), or local (never replicated).
4. **Semantic graph runtime.** The ECS is a graph of typed relationships — components are schemas, relationships are predicates, queries are pattern matching.

**Tech stack:** TypeScript, bitECS v4, TypeBox, Vitest

**Dependency chain:** This is Spec 03 (Tier 1–2). Depends on:

- `01-world-entity.md` — World, Entity types
- `02-component-definitions.md` — `defineComponent`, `setComponent`, `ComponentDefinition`, `Schema`, observers

Depended on by:

- `04-systems-prefabs-serialization.md` — queries with relationships, prefab identity
- `05-mutation-pipeline.md` — relationship mutations in authored pipeline
- `06-users-peers-authority.md` — OwnedBy, AuthoritativeFor, BelongsTo(peer→user)
- `07-governance.md` — HasConstraint relation, scope hierarchy walking

---

## Scope & Intent

This spec defines two major subsystems:

1. **Relations** — typed links between entities, expressed as bitECS relationship pairs. Relations are semantic predicates: `(subject, relation, target)` forms a triple. They support modifiers (exclusive, autoRemoveSubject, cascade), data on pairs, and wildcard queries.

2. **Entity Identity** — how entities are uniquely addressable across the network. Built on `BelongsTo` (identity context) + `UIDComponent` (unique name within context). The nameCache provides O(1) lookups. Identity paths enable network-safe addressing without exposing runtime-local entity IDs.

Key distinctions:

- `BelongsTo` = identity/naming context (exclusive: one parent)
- `ChildOf` = entity hierarchy (transform inheritance, cascade delete)
- These are separate relations that MAY coincide but serve different purposes.

---

## Requirements

### R1: defineRelation

```typescript
/**
 * Options for defining a named relation type.
 */
interface RelationOptions<T = void> {
  /**
   * If true, an entity can have only ONE target for this relation.
   * Adding a new target automatically removes the previous one.
   * @default false
   */
  exclusive?: boolean

  /**
   * If true, removing the target entity automatically removes the subject entity.
   * Cascade delete.
   * @default false
   */
  autoRemoveSubject?: boolean

  /**
   * Factory function for data stored on each relationship pair.
   * If provided, each (subject, target) pair carries this data.
   * Accessed via relation(target).fieldName[subject].
   */
  store?: () => T

  /**
   * Callback fired when the target entity is removed.
   * Only called if autoRemoveSubject is false.
   */
  onTargetRemoved?: (world: World, subject: Entity, target: Entity) => void

  /**
   * How relationship add/remove operations propagate over the network.
   * - 'authored': reliable, governance-validated (default)
   * - 'local': never replicated
   *
   * Relationships are always discrete mutations (not continuous),
   * so 'runtime' is not applicable.
   * @default 'authored'
   */
  mutationCategory?: 'authored' | 'local'
}

/**
 * A registered relation type. Returned by defineRelation().
 * Can be called as a function to create pair references: Relation(target).
 */
interface RelationDefinition<T = void> {
  /** Relation name — used as the predicate in semantic mutations */
  readonly name: string

  /** Whether this relation is exclusive (one target per entity) */
  readonly exclusive: boolean

  /** Whether removing the target cascades to removing the subject */
  readonly autoRemoveSubject: boolean

  /** Whether this relation carries data on pairs */
  readonly hasStore: boolean

  /** How add/remove operations propagate */
  readonly mutationCategory: 'authored' | 'local';

  /**
   * Create a pair reference for a specific target entity.
   * Used with bitECS addComponent/removeComponent/query.
   *
   * @param target - The target entity
   * @returns A pair reference usable as a component in bitECS operations
   *
   * @example
   * addComponent(world, child, ChildOf(parent))
   * query(world, [ChildOf(parent)])
   * query(world, [ChildOf(Wildcard)]) // any parent
   */
  (target: Entity | typeof Wildcard): PairReference<T>
}

/**
 * A reference to a specific (relation, target) pair.
 * Returned by calling a RelationDefinition with a target.
 * Used as a component reference in bitECS operations.
 */
interface PairReference<T = void> {
  /** The relation this pair belongs to */
  readonly relation: RelationDefinition<T>
  /** The target entity (or Wildcard) */
  readonly target: Entity | typeof Wildcard
}

/**
 * Define a named relation type.
 *
 * Wraps bitECS `createRelation` and adds:
 * - A name for serialisation and network protocol
 * - A mutation category (authored by default)
 * - Integration with the Connection Engine mutation pipeline
 *
 * @param name - Unique relation name (used as predicate URI, e.g. 'ce:ChildOf')
 * @param options - Relation modifiers
 * @returns A RelationDefinition callable as `Relation(target)`
 *
 * @example
 * const ChildOf = defineRelation('ChildOf', {
 *   exclusive: true,
 *   autoRemoveSubject: true,
 * })
 *
 * const EquippedBy = defineRelation('EquippedBy', {
 *   exclusive: true,
 *   store: () => ({ slot: '' }),
 * })
 */
declare function defineRelation<T = void>(name: string, options?: RelationOptions<T>): RelationDefinition<T>
```

#### Pseudocode

```
function defineRelation(name, options?):
  if relationRegistry.has(name):
    throw Error(`Relation '${name}' already defined`)

  bitECSRelation = bitecs.createRelation({
    exclusive: options?.exclusive ?? false,
    autoRemoveSubject: options?.autoRemoveSubject ?? false,
    store: options?.store,
    onTargetRemoved: options?.onTargetRemoved,
  })

  definition = Object.assign(
    (target) => bitECSRelation(target),  // callable as Relation(target)
    {
      name,
      exclusive: options?.exclusive ?? false,
      autoRemoveSubject: options?.autoRemoveSubject ?? false,
      hasStore: options?.store !== undefined,
      mutationCategory: options?.mutationCategory ?? 'authored',
    }
  )

  relationRegistry.set(name, definition)
  return definition
```

### R2: Relationship Pairs as Semantic Triples

Every relationship pair `(subject, relation, target)` is a semantic triple. This is the structural foundation for the semantic graph runtime.

```typescript
/**
 * Add a relationship between two entities.
 *
 * Creates the pair (subject, relation, target) in the ECS.
 * If relation.exclusive is true and the subject already has a target
 * for this relation, the old target is replaced.
 *
 * If relation.mutationCategory is 'authored', the add operation is
 * queued as a structured mutation for end-of-tick batch (Spec 05).
 *
 * @param world - The world
 * @param subject - The subject entity
 * @param relation - The relation definition
 * @param target - The target entity
 *
 * @example
 * addRelation(world, child, ChildOf, parent)
 * // Equivalent to: bitecs.addComponent(world, child, ChildOf(parent))
 */
declare function addRelation(world: World, subject: Entity, relation: RelationDefinition, target: Entity): void

/**
 * Remove a relationship between two entities.
 *
 * Removes the pair (subject, relation, target) from the ECS.
 * If relation.mutationCategory is 'authored', the removal is
 * queued as a structured mutation.
 *
 * @param world - The world
 * @param subject - The subject entity
 * @param relation - The relation definition
 * @param target - The target entity
 */
declare function removeRelation(world: World, subject: Entity, relation: RelationDefinition, target: Entity): void

/**
 * Check if a relationship exists between two entities.
 *
 * @param world - The world
 * @param subject - The subject entity
 * @param relation - The relation definition
 * @param target - The target entity
 * @returns true if the relationship pair exists
 */
declare function hasRelation(world: World, subject: Entity, relation: RelationDefinition, target: Entity): boolean

/**
 * Get the target(s) of a relation for a given subject entity.
 *
 * For exclusive relations, returns at most one target.
 * For non-exclusive relations, returns all targets.
 *
 * @param world - The world
 * @param subject - The subject entity
 * @param relation - The relation definition
 * @returns Array of target entities
 */
declare function getRelationTargets(world: World, subject: Entity, relation: RelationDefinition): Entity[]

/**
 * Get data stored on a relationship pair.
 * Only available for relations defined with a `store` factory.
 *
 * @param world - The world
 * @param subject - The subject entity
 * @param relation - The relation definition
 * @param target - The target entity
 * @returns The stored data, or undefined if no store or no pair
 */
declare function getRelationData<T>(
  world: World,
  subject: Entity,
  relation: RelationDefinition<T>,
  target: Entity
): T | undefined

/**
 * Set data on a relationship pair.
 * Only available for relations defined with a `store` factory.
 *
 * @param world - The world
 * @param subject - The subject entity
 * @param relation - The relation definition
 * @param target - The target entity
 * @param data - Partial data to merge into the pair store
 */
declare function setRelationData<T>(
  world: World,
  subject: Entity,
  relation: RelationDefinition<T>,
  target: Entity,
  data: Partial<T>
): void
```

### R3: Wildcard Queries

Wildcard queries allow matching any target entity in relationship queries.

```typescript
import { Wildcard } from 'bitecs'

/**
 * Wildcard — matches any target in a relationship query.
 *
 * @example
 * // Find all entities that are a child of ANY entity
 * query(world, [ChildOf(Wildcard)])
 *
 * // Find all entities owned by ANY user
 * query(world, [OwnedBy(Wildcard)])
 *
 * // Combine with component queries
 * query(world, [ChildOf(Wildcard), Transform, Health])
 */
```

### R4: Cascade Behaviour

```
When target entity is removed:
  for each relation where target is referenced:
    for each subject that has Relation(target):
      if relation.autoRemoveSubject:
        removeEntity(world, subject)  // cascade delete
      else if relation.onTargetRemoved:
        relation.onTargetRemoved(world, subject, target)
      else:
        removeRelation(world, subject, relation, target)  // just remove the pair
```

### R5: Built-in Relations

```typescript
/**
 * ChildOf — entity hierarchy relation.
 * Purpose: transform inheritance, cascade delete, scene graph structure.
 * Exclusive: an entity has at most one parent in the scene hierarchy.
 * autoRemoveSubject: removing parent removes children.
 */
const ChildOf: RelationDefinition = defineRelation('ChildOf', {
  exclusive: true,
  autoRemoveSubject: true,
  mutationCategory: 'authored'
})

/**
 * BelongsTo — identity context relation.
 * Purpose: UID scoping, naming, network identity resolution.
 * Exclusive: an entity belongs to exactly one identity context.
 * NOT the same as ChildOf:
 *   - ChildOf = hierarchy (transforms, cascade)
 *   - BelongsTo = identity (naming, uniqueness, address resolution)
 *
 * An entity can have both: ChildOf(armatureNode) for transform
 * AND BelongsTo(modelInstance) for identity.
 */
const BelongsTo: RelationDefinition = defineRelation('BelongsTo', {
  exclusive: true,
  autoRemoveSubject: false,
  mutationCategory: 'authored'
})
```

### R6: UIDComponent

```typescript
/**
 * UIDComponent — stores an entity's unique identifier within its BelongsTo parent scope.
 *
 * UIDs are unique per BelongsTo parent. Enforced by an onSet observer
 * that checks for duplicate UIDs among siblings sharing the same BelongsTo target.
 *
 * Defined using defineComponent from Spec 02.
 */
const UIDComponent: ComponentDefinition = defineComponent({
  id: 'UID',
  label: 'UID',
  mutationCategory: 'authored',
  schema: Schema.Object({
    /** The entity's UID — unique among siblings sharing the same BelongsTo target */
    value: Schema.String()
  })
})
```

#### Uniqueness Enforcement Pseudocode

```
// Observer on UIDComponent — enforces uniqueness per BelongsTo parent
observe(world, onSet(UIDComponent), (entity, data) => {
  const uid = data.value
  const targets = getRelationTargets(world, entity, BelongsTo)
  const parent = targets.length > 0 ? targets[0] : ROOT_CONTEXT

  const siblings = world.nameCache.get(parent)
  if (siblings) {
    const existing = siblings.get(uid)
    if (existing !== undefined && existing !== entity) {
      throw new Error(`UID '${uid}' already exists under parent ${parent}`)
    }
  }
})
```

### R7: nameCache Maintenance

The `World.nameCache` (defined in Spec 01) is a `Map<Entity, Map<string, Entity>>` that maps each parent entity to a `(uid → child entity)` lookup table. It is maintained automatically via observers on `BelongsTo` and `UIDComponent`.

```typescript
/**
 * Root context constant — used as the nameCache key for entities
 * that have a UID but no BelongsTo parent (top-level entities).
 */
const ROOT_CONTEXT: Entity = 0 // entity 0 as sentinel for root
```

#### nameCache Observer Setup

```
// When UIDComponent is added or its value changes:
observe(world, onSet(UIDComponent), (entity) => {
  const uid = getComponent(world, entity, UIDComponent)!.value
  const targets = getRelationTargets(world, entity, BelongsTo)
  const parent = targets.length > 0 ? targets[0] : ROOT_CONTEXT

  if (!world.nameCache.has(parent)) {
    world.nameCache.set(parent, new Map())
  }
  world.nameCache.get(parent)!.set(uid, entity)
})

// When BelongsTo changes (entity moves to new parent):
observe(world, onAdd(BelongsTo(Wildcard)), (entity) => {
  // If entity has a UID, update nameCache for new parent
  const uidData = getComponent(world, entity, UIDComponent)
  if (!uidData) return

  const uid = uidData.value
  const targets = getRelationTargets(world, entity, BelongsTo)
  const newParent = targets[0]

  // Remove from old parent (handled by onRemove below)
  // Add to new parent
  if (!world.nameCache.has(newParent)) {
    world.nameCache.set(newParent, new Map())
  }
  world.nameCache.get(newParent)!.set(uid, entity)
})

// When UIDComponent is removed:
observe(world, onRemove(UIDComponent), (entity) => {
  const uid = getComponent(world, entity, UIDComponent)!.value
  const targets = getRelationTargets(world, entity, BelongsTo)
  const parent = targets.length > 0 ? targets[0] : ROOT_CONTEXT

  const siblings = world.nameCache.get(parent)
  if (siblings) {
    siblings.delete(uid)
    if (siblings.size === 0) {
      world.nameCache.delete(parent)
    }
  }
})

// When BelongsTo is removed:
observe(world, onRemove(BelongsTo(Wildcard)), (entity) => {
  // Remove from old parent's nameCache
  // (UID and old parent are still accessible during onRemove)
  const uidData = getComponent(world, entity, UIDComponent)
  if (!uidData) return

  const uid = uidData.value
  // old parent was the previous BelongsTo target
  // bitECS provides the target during onRemove
  // Remove uid → entity mapping from old parent
})
```

### R8: Identity Path Resolution

```typescript
/**
 * Find an entity by UID within a parent's identity scope.
 * Uses world.nameCache for O(1) lookup.
 *
 * @param world - The world
 * @param parent - The parent entity (BelongsTo target), or ROOT_CONTEXT (0) for top-level
 * @param uid - The UID to look up
 * @returns The entity, or undefined if not found
 *
 * @example
 * const player = getEntityByUID(world, sceneEntity, 'Player1')
 */
declare function getEntityByUID(world: World, parent: Entity, uid: string): Entity | undefined

/**
 * Get the full identity path for an entity by walking its BelongsTo chain.
 *
 * Returns an array of UIDs from root to entity.
 * Each entry is the UIDComponent.value at that level.
 *
 * @param world - The world
 * @param entity - The entity to get the path for
 * @returns Array of UIDs from root to entity, e.g. ['MainScene', 'Player1']
 *         Empty array if entity has no UID.
 *
 * @example
 * const path = getEntityPath(world, playerEntity)
 * // ['MainScene', 'Player1']
 */
declare function getEntityPath(world: World, entity: Entity): string[]

/**
 * Resolve an entity from a path of UIDs, walking BelongsTo contexts from root.
 * Inverse of getEntityPath.
 *
 * @param world - The world
 * @param path - Array of UIDs, e.g. ['MainScene', 'Player1']
 * @returns The entity at the end of the path, or undefined if any segment is missing
 *
 * @example
 * const player = resolveEntityPath(world, ['MainScene', 'Player1'])
 */
declare function resolveEntityPath(world: World, path: string[]): Entity | undefined
```

#### Pseudocode

```
function getEntityByUID(world, parent, uid):
  siblings = world.nameCache.get(parent)
  if !siblings:
    return undefined
  return siblings.get(uid)

function getEntityPath(world, entity):
  path = []
  current = entity

  while current is valid:
    uidData = getComponent(world, current, UIDComponent)
    if !uidData:
      break
    path.unshift(uidData.value)
    targets = getRelationTargets(world, current, BelongsTo)
    if targets.length === 0:
      break
    current = targets[0]

  return path

function resolveEntityPath(world, path):
  if path.length === 0:
    return undefined

  current = ROOT_CONTEXT

  for uid of path:
    entity = getEntityByUID(world, current, uid)
    if entity === undefined:
      return undefined
    current = entity

  return current
```

### R9: Queries with Relationships

Queries in bitECS support relationship pairs as terms, including wildcard targets. Connection Engine re-exports and integrates these.

```typescript
import { query, Wildcard } from 'bitecs'

/**
 * Query entities matching component and relationship criteria.
 *
 * bitECS queries use archetype tables — O(1) per archetype.
 * Relationship pairs get unique component IDs, so relationship
 * queries use the same mechanism as component queries.
 *
 * @param world - The world
 * @param terms - Array of components and/or relationship pairs
 * @returns Array of matching entity IDs
 *
 * @example
 * // All entities that are children of a specific parent
 * const children = query(world, [ChildOf(parent)])
 *
 * // All entities that are children of ANY entity
 * const allChildren = query(world, [ChildOf(Wildcard)])
 *
 * // All entities with Transform that are children of scene
 * const positioned = query(world, [ChildOf(scene), Transform])
 *
 * // Composable with Or, Not
 * const dynamic = query(world, [Transform, Not(Static)])
 */
declare function query(world: World, terms: Array<ComponentDefinition | PairReference>): Entity[]
```

### R10: Relationship Observers

Observers work with relationship pairs just like components.

```typescript
/**
 * Observe relationship changes using bitECS observer API.
 *
 * @example
 * // When any ChildOf relationship is added
 * observe(world, onAdd(ChildOf(Wildcard)), (entity) => {
 *   console.log(entity, 'became a child of something')
 * })
 *
 * // When a specific relationship is added
 * observe(world, onAdd(ChildOf(sceneEntity)), (entity) => {
 *   console.log(entity, 'became a child of the scene')
 * })
 *
 * // When an entity is no longer a child
 * observe(world, onRemove(ChildOf(Wildcard)), (entity) => {
 *   console.log(entity, 'is no longer a child')
 * })
 */
```

---

## Test Specifications

### defineRelation Tests

```typescript
import { describe, it, expect } from 'vitest'
import { defineRelation, addRelation, removeRelation, hasRelation, getRelationTargets } from '../src/relation'
import { createWorld, destroyWorld } from '../src/world'
import { createEntity } from '../src/entity'

describe('defineRelation', () => {
  it('should create a relation with default options', () => {
    const Likes = defineRelation('Likes')

    expect(Likes.name).toBe('Likes')
    expect(Likes.exclusive).toBe(false)
    expect(Likes.autoRemoveSubject).toBe(false)
    expect(Likes.hasStore).toBe(false)
    expect(Likes.mutationCategory).toBe('authored')
  })

  it('should create an exclusive relation', () => {
    const Follows = defineRelation('Follows', { exclusive: true })

    expect(Follows.exclusive).toBe(true)
  })

  it('should create a relation with autoRemoveSubject', () => {
    const AttachedTo = defineRelation('AttachedTo', {
      autoRemoveSubject: true
    })

    expect(AttachedTo.autoRemoveSubject).toBe(true)
  })

  it('should create a relation with a store', () => {
    const EquippedBy = defineRelation('EquippedBy', {
      exclusive: true,
      store: () => ({ slot: '' })
    })

    expect(EquippedBy.hasStore).toBe(true)
  })

  it('should create a local relation', () => {
    const SelectedBy = defineRelation('SelectedBy', {
      mutationCategory: 'local'
    })

    expect(SelectedBy.mutationCategory).toBe('local')
  })

  it('should throw on duplicate relation name', () => {
    defineRelation('UniqueLikes')

    expect(() => defineRelation('UniqueLikes')).toThrow()
  })
})
```

### Relationship Pair Tests

```typescript
describe('Relationship Pairs', () => {
  it('should add and check a relationship', () => {
    const world = createWorld()
    const Likes = defineRelation('LikesTest')
    const alice = createEntity(world)
    const bob = createEntity(world)

    addRelation(world, alice, Likes, bob)

    expect(hasRelation(world, alice, Likes, bob)).toBe(true)
    expect(hasRelation(world, bob, Likes, alice)).toBe(false) // not bidirectional

    destroyWorld(world)
  })

  it('should remove a relationship', () => {
    const world = createWorld()
    const Knows = defineRelation('KnowsTest')
    const a = createEntity(world)
    const b = createEntity(world)

    addRelation(world, a, Knows, b)
    expect(hasRelation(world, a, Knows, b)).toBe(true)

    removeRelation(world, a, Knows, b)
    expect(hasRelation(world, a, Knows, b)).toBe(false)

    destroyWorld(world)
  })

  it('should get relation targets', () => {
    const world = createWorld()
    const Tags = defineRelation('TagsTest')
    const entity = createEntity(world)
    const tag1 = createEntity(world)
    const tag2 = createEntity(world)

    addRelation(world, entity, Tags, tag1)
    addRelation(world, entity, Tags, tag2)

    const targets = getRelationTargets(world, entity, Tags)
    expect(targets).toContain(tag1)
    expect(targets).toContain(tag2)
    expect(targets).toHaveLength(2)

    destroyWorld(world)
  })

  it('should enforce exclusive relation — replacing previous target', () => {
    const world = createWorld()
    const ParentOf = defineRelation('ExclusiveParent', { exclusive: true })
    const child = createEntity(world)
    const parent1 = createEntity(world)
    const parent2 = createEntity(world)

    addRelation(world, child, ParentOf, parent1)
    expect(hasRelation(world, child, ParentOf, parent1)).toBe(true)

    addRelation(world, child, ParentOf, parent2)
    expect(hasRelation(world, child, ParentOf, parent2)).toBe(true)
    expect(hasRelation(world, child, ParentOf, parent1)).toBe(false) // replaced

    destroyWorld(world)
  })

  it('should cascade delete with autoRemoveSubject', () => {
    const world = createWorld()
    const OwnedByTest = defineRelation('OwnedByTest', {
      autoRemoveSubject: true
    })
    const owner = createEntity(world)
    const item = createEntity(world)

    addRelation(world, item, OwnedByTest, owner)

    // Remove the owner — item should be cascade-deleted
    removeEntity(world, owner)

    // After cascade, queries for item should return nothing
    // (entity was removed along with owner)
    // The exact assertion depends on how we detect "entity exists"
    // Using hasComponent with a known component or checking query results
    expect(hasRelation(world, item, OwnedByTest, owner)).toBe(false)

    destroyWorld(world)
  })
})
```

### Relation Data Tests

```typescript
import { getRelationData, setRelationData } from '../src/relation'

describe('Relation Data (withStore)', () => {
  it('should store and retrieve data on a relationship pair', () => {
    const world = createWorld()
    const EquippedBy = defineRelation('EquippedByTest', {
      exclusive: true,
      store: () => ({ slot: '' as string })
    })

    const weapon = createEntity(world)
    const player = createEntity(world)

    addRelation(world, weapon, EquippedBy, player)
    setRelationData(world, weapon, EquippedBy, player, { slot: 'rightHand' })

    const data = getRelationData(world, weapon, EquippedBy, player)
    expect(data).toBeDefined()
    expect(data!.slot).toBe('rightHand')

    destroyWorld(world)
  })

  it('should return undefined for relations without store', () => {
    const world = createWorld()
    const NoStore = defineRelation('NoStoreTest')
    const a = createEntity(world)
    const b = createEntity(world)

    addRelation(world, a, NoStore, b)

    const data = getRelationData(world, a, NoStore, b)
    expect(data).toBeUndefined()

    destroyWorld(world)
  })
})
```

### BelongsTo + UIDComponent Tests

```typescript
import { BelongsTo, ChildOf } from '../src/relations'
import { UIDComponent } from '../src/identity'
import { setComponent, getComponent } from '../src/component'

describe('BelongsTo and UIDComponent', () => {
  it('should set BelongsTo as exclusive identity context', () => {
    const world = createWorld()
    const scene = createEntity(world)
    const entity = createEntity(world)

    addRelation(world, entity, BelongsTo, scene)

    const targets = getRelationTargets(world, entity, BelongsTo)
    expect(targets).toEqual([scene])

    destroyWorld(world)
  })

  it('should enforce UID uniqueness per BelongsTo parent', () => {
    const world = createWorld()
    const scene = createEntity(world)
    const e1 = createEntity(world)
    const e2 = createEntity(world)

    addRelation(world, e1, BelongsTo, scene)
    addRelation(world, e2, BelongsTo, scene)

    setComponent(world, e1, UIDComponent, { value: 'Player1' })

    // Setting the same UID on a sibling should throw
    expect(() => {
      setComponent(world, e2, UIDComponent, { value: 'Player1' })
    }).toThrow()

    destroyWorld(world)
  })

  it('should allow same UID under different parents', () => {
    const world = createWorld()
    const scene1 = createEntity(world)
    const scene2 = createEntity(world)
    const e1 = createEntity(world)
    const e2 = createEntity(world)

    addRelation(world, e1, BelongsTo, scene1)
    addRelation(world, e2, BelongsTo, scene2)

    setComponent(world, e1, UIDComponent, { value: 'Entity' })
    setComponent(world, e2, UIDComponent, { value: 'Entity' })

    // Both should succeed — different parents
    const uid1 = getComponent(world, e1, UIDComponent)
    const uid2 = getComponent(world, e2, UIDComponent)
    expect(uid1!.value).toBe('Entity')
    expect(uid2!.value).toBe('Entity')

    destroyWorld(world)
  })

  it('should distinguish BelongsTo from ChildOf', () => {
    const world = createWorld()
    const armature = createEntity(world)
    const model = createEntity(world)
    const bone = createEntity(world)

    // Bone is a child of armature (transform hierarchy)
    addRelation(world, bone, ChildOf, armature)
    // Bone belongs to model (identity context)
    addRelation(world, bone, BelongsTo, model)

    const childOfTargets = getRelationTargets(world, bone, ChildOf)
    const belongsToTargets = getRelationTargets(world, bone, BelongsTo)

    expect(childOfTargets).toEqual([armature])
    expect(belongsToTargets).toEqual([model])

    destroyWorld(world)
  })
})
```

### nameCache Tests

```typescript
import { getEntityByUID, getEntityPath, resolveEntityPath, ROOT_CONTEXT } from '../src/identity'

describe('nameCache', () => {
  it('should populate nameCache when UIDComponent is set', () => {
    const world = createWorld()
    const entity = createEntity(world)

    setComponent(world, entity, UIDComponent, { value: 'TestEntity' })

    // Top-level entity — uses ROOT_CONTEXT
    expect(world.nameCache.get(ROOT_CONTEXT)?.get('TestEntity')).toBe(entity)

    destroyWorld(world)
  })

  it('should populate nameCache under correct parent', () => {
    const world = createWorld()
    const scene = createEntity(world)
    const entity = createEntity(world)

    setComponent(world, scene, UIDComponent, { value: 'MainScene' })
    addRelation(world, entity, BelongsTo, scene)
    setComponent(world, entity, UIDComponent, { value: 'Player1' })

    expect(world.nameCache.get(scene)?.get('Player1')).toBe(entity)

    destroyWorld(world)
  })

  it('should clean up nameCache when UIDComponent is removed', () => {
    const world = createWorld()
    const entity = createEntity(world)

    setComponent(world, entity, UIDComponent, { value: 'Temporary' })
    expect(world.nameCache.get(ROOT_CONTEXT)?.get('Temporary')).toBe(entity)

    removeComponent(world, entity, UIDComponent)
    expect(world.nameCache.get(ROOT_CONTEXT)?.get('Temporary')).toBeUndefined()

    destroyWorld(world)
  })
})
```

### Identity Path Resolution Tests

```typescript
describe('Identity Path Resolution', () => {
  it('should look up entity by UID via getEntityByUID', () => {
    const world = createWorld()
    const scene = createEntity(world)
    const player = createEntity(world)

    setComponent(world, scene, UIDComponent, { value: 'MainScene' })
    addRelation(world, player, BelongsTo, scene)
    setComponent(world, player, UIDComponent, { value: 'Player1' })

    expect(getEntityByUID(world, scene, 'Player1')).toBe(player)
    expect(getEntityByUID(world, scene, 'NonExistent')).toBeUndefined()

    destroyWorld(world)
  })

  it('should build entity path via getEntityPath', () => {
    const world = createWorld()
    const scene = createEntity(world)
    const zone = createEntity(world)
    const entity = createEntity(world)

    setComponent(world, scene, UIDComponent, { value: 'MainScene' })
    addRelation(world, zone, BelongsTo, scene)
    setComponent(world, zone, UIDComponent, { value: 'ArenaZone' })
    addRelation(world, entity, BelongsTo, zone)
    setComponent(world, entity, UIDComponent, { value: 'Chest' })

    const path = getEntityPath(world, entity)
    expect(path).toEqual(['MainScene', 'ArenaZone', 'Chest'])

    destroyWorld(world)
  })

  it('should resolve entity from path via resolveEntityPath', () => {
    const world = createWorld()
    const scene = createEntity(world)
    const player = createEntity(world)

    setComponent(world, scene, UIDComponent, { value: 'MainScene' })
    addRelation(world, player, BelongsTo, scene)
    setComponent(world, player, UIDComponent, { value: 'Player1' })

    const resolved = resolveEntityPath(world, ['MainScene', 'Player1'])
    expect(resolved).toBe(player)

    destroyWorld(world)
  })

  it('should return undefined for partially valid paths', () => {
    const world = createWorld()
    const scene = createEntity(world)

    setComponent(world, scene, UIDComponent, { value: 'MainScene' })

    const resolved = resolveEntityPath(world, ['MainScene', 'NonExistent'])
    expect(resolved).toBeUndefined()

    destroyWorld(world)
  })

  it('should return undefined for empty path', () => {
    const world = createWorld()

    expect(resolveEntityPath(world, [])).toBeUndefined()

    destroyWorld(world)
  })

  it('should be inverse operations — getEntityPath and resolveEntityPath', () => {
    const world = createWorld()
    const scene = createEntity(world)
    const entity = createEntity(world)

    setComponent(world, scene, UIDComponent, { value: 'Scene' })
    addRelation(world, entity, BelongsTo, scene)
    setComponent(world, entity, UIDComponent, { value: 'Entity' })

    const path = getEntityPath(world, entity)
    const resolved = resolveEntityPath(world, path)
    expect(resolved).toBe(entity)

    destroyWorld(world)
  })
})
```

### Query with Relationship Tests

```typescript
import { query, Wildcard } from '../src/query'

describe('Queries with Relationships', () => {
  it('should query entities by specific relationship target', () => {
    const world = createWorld()
    const parent = createEntity(world)
    const child1 = createEntity(world)
    const child2 = createEntity(world)
    const unrelated = createEntity(world)

    addRelation(world, child1, ChildOf, parent)
    addRelation(world, child2, ChildOf, parent)

    const children = query(world, [ChildOf(parent)])
    expect(children).toContain(child1)
    expect(children).toContain(child2)
    expect(children).not.toContain(unrelated)

    destroyWorld(world)
  })

  it('should query entities by wildcard relationship', () => {
    const world = createWorld()
    const p1 = createEntity(world)
    const p2 = createEntity(world)
    const c1 = createEntity(world)
    const c2 = createEntity(world)
    const orphan = createEntity(world)

    addRelation(world, c1, ChildOf, p1)
    addRelation(world, c2, ChildOf, p2)

    const allChildren = query(world, [ChildOf(Wildcard)])
    expect(allChildren).toContain(c1)
    expect(allChildren).toContain(c2)
    expect(allChildren).not.toContain(orphan)

    destroyWorld(world)
  })

  it('should combine component and relationship queries', () => {
    const world = createWorld()
    const Transform = defineComponent({
      id: 'TransformQueryTest',
      label: 'Transform',
      schema: Schema.Object({ position: Schema.Vec3() })
    })

    const scene = createEntity(world)
    const e1 = createEntity(world)
    const e2 = createEntity(world)

    addRelation(world, e1, ChildOf, scene)
    addRelation(world, e2, ChildOf, scene)
    setComponent(world, e1, Transform, { position: [0, 0, 0] })
    // e2 has ChildOf but no Transform

    const positioned = query(world, [ChildOf(scene), Transform])
    expect(positioned).toContain(e1)
    expect(positioned).not.toContain(e2)

    destroyWorld(world)
  })
})
```

---

## Edge Cases & Constraints

1. **Relation names must be globally unique.** `defineRelation` with a duplicate name must throw.

2. **BelongsTo is exclusive.** An entity can have at most one BelongsTo target. Setting a new BelongsTo removes the old one. The nameCache must update accordingly.

3. **UID uniqueness is per BelongsTo parent only.** Two entities with different BelongsTo parents can have the same UID. Two entities with the same (or no) BelongsTo parent cannot.

4. **Top-level entities.** Entities with a UID but no BelongsTo parent use `ROOT_CONTEXT` (entity 0) as their nameCache key.

5. **Cascade deletion order.** When `autoRemoveSubject` triggers, the cascade proceeds depth-first. Deeply nested hierarchies cascade recursively.

6. **Observer firing during cascade.** When cascade deletion removes entities, observers fire for each removed component and relationship. This can trigger further cascades. Implementations must handle re-entrant removal gracefully.

7. **nameCache consistency.** The nameCache must be updated before UID uniqueness checks. If an entity's UID changes, the old mapping must be removed and the new one added atomically (within the same observer call).

8. **Relationship pairs as components.** In bitECS, relationship pairs are implemented as components with unique IDs. This means relationship queries use the same archetype-based mechanism as component queries. The RelationDefinition is callable (`Relation(target)`) to produce the pair component reference.

9. **Wildcard in query only.** `Wildcard` is used in `query` and `observe` for matching any target. It cannot be used with `addRelation` or `hasRelation` — those require a specific target entity.

---

## Dependencies

- **Spec 01 (`01-world-entity.md`)**: World (with nameCache), Entity, createEntity, removeEntity
- **Spec 02 (`02-component-definitions.md`)**: defineComponent, setComponent, getComponent, removeComponent, hasComponent, Schema, observers (observe, onAdd, onRemove, onSet)
- **bitECS v4**: `createRelation`, `addComponent`, `removeComponent`, `query`, `Wildcard`, observer API
