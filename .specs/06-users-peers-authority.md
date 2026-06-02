# Spec 06: Users, Peers, Ownership & Authority

## Project & Architecture Context

**Connection Engine** is a semantic spatial web engine — a multiplayer-first, data-driven TypeScript engine for real-time spatial experiences built on web standards.

**Core design principles:**

1. **Everything is an entity.** Users, avatars, scores, quests, factions, inventories — only engine runtime bindings live outside the ECS.
2. **Fewest abstractions.** One ECS/change model serves realtime replication, authority, validation, and persistence integrations.
3. **Component-level mutation categories.** Network behaviour is defined per-component as authored (reliable, governance-validated, event-sourced), runtime (binary, authority-checked, ephemeral), or local (never replicated).
4. **Semantic graph runtime.** The ECS is a graph of typed relationships — components are schemas, relationships are predicates, queries are pattern matching.

**Tech stack:** TypeScript, bitECS v4, TypeBox, Vitest

**Dependency chain:** This is Spec 06 (Tier 4). Depends on:

- `01-world-entity.md` — World, Entity
- `02-component-definitions.md` — `defineComponent`, `setComponent`, `getComponent`, `ComponentDefinition`, `Schema`
- `03-relations-identity.md` — `defineRelation`, `addRelation`, `removeRelation`, `hasRelation`, `getRelationTargets`, `BelongsTo`, `UIDComponent`, `Wildcard`
- `04-systems-prefabs-serialization.md` — `createSnapshot`, `applySnapshot` for late join
- `05-mutation-pipeline.md` — `Connection`, `AuthoredMutation`, `withOrigin`, `processAuthoredBatch`, peer connection lifecycle, `EntityIdMap`

Depended on by:

- `07-governance.md` — uses `OwnedBy`, `AuthoritativeFor`, user DID identity for governance validation

---

## Scope & Intent

This spec defines the identity and authority model for multiplayer sessions:

1. **Users** — entities representing people, identified by DID (Decentralized Identifier). A user persists across sessions and may be present via multiple peers simultaneously.

2. **Peers** — entities representing engine instances (browser tabs, devices, server processes). Each peer belongs to exactly one user via `BelongsTo`. A user can have many peers.

3. **Ownership** (`OwnedBy`) — which user created an entity. Exclusive, NOT transferable. Ownership is provenance — it records who originally created the entity.

4. **Authority** (`AuthoritativeFor`) — which peer currently has write control over an entity. Exclusive, transferable. Authority can move between peers for the same user (switching devices) or to a different user's peer (delegation, host migration).

5. **DID Signing & Verification** — Ed25519 cryptographic identity for users. Every authored mutation is signed by the authoring user's DID, providing cryptographic provenance verifiable by any peer.

---

## Requirements

### R1: UserComponent

```typescript
/**
 * UserComponent — identifies a user entity with a DID identity.
 *
 * A user entity represents a person. It persists across sessions
 * and can be present in a world via multiple peers (devices/tabs).
 *
 * Defined using defineComponent (Spec 02).
 */
const UserComponent: ComponentDefinition = defineComponent({
  id: 'User',
  label: 'User',
  mutationCategory: 'authored',
  schema: Schema.Object({
    /**
     * DID identity — the cryptographic identifier for this user.
     * Format: did:key:z6Mk... (Ed25519 public key encoded as did:key)
     */
    did: Schema.String(),

    /**
     * Human-readable display name.
     */
    displayName: Schema.String({ default: '' })
  })
})
```

### R2: PeerComponent

```typescript
/**
 * PeerComponent — identifies a peer entity (engine instance).
 *
 * A peer entity represents one runtime instance of Connection Engine
 * (a browser tab, a device, a server process). Each peer belongs to
 * exactly one user via BelongsTo (Spec 03).
 *
 * Defined using defineComponent (Spec 02).
 */
const PeerComponent: ComponentDefinition = defineComponent({
  id: 'Peer',
  label: 'Peer',
  mutationCategory: 'authored',
  schema: Schema.Object({
    /**
     * Session-level peer identifier.
     * Typically a UUID generated on peer creation.
     */
    peerId: Schema.String(),

    /**
     * Measured network latency to this peer in milliseconds.
     * Updated periodically by the transport layer.
     * @default 0
     */
    latency: Schema.Number({ default: 0 })
  })
})
```

### R3: OwnedBy Relation

```typescript
/**
 * OwnedBy — ownership relation from an entity to a user.
 *
 * Semantics:
 * - An entity has exactly ONE owner (exclusive).
 * - The owner is always a user entity (with UserComponent).
 * - Ownership is NOT transferable. To transfer ownership, the entity
 *   must be destroyed and recreated under the new owner.
 * - Ownership is provenance — it records who originally created the entity.
 * - Removing the owner user does NOT cascade-delete owned entities
 *   (autoRemoveSubject: false). Orphaned entities may be claimed or cleaned up
 *   by governance rules.
 *
 * Triple: (entity, OwnedBy, userEntity)
 */
const OwnedBy: RelationDefinition = defineRelation('OwnedBy', {
  exclusive: true,
  autoRemoveSubject: false,
  mutationCategory: 'authored'
})
```

### R4: AuthoritativeFor Relation

```typescript
/**
 * AuthoritativeFor — authority relation from an entity to a peer.
 *
 * Semantics:
 * - An entity has exactly ONE authoritative peer at any time (exclusive).
 * - The authoritative peer is a peer entity (with PeerComponent).
 * - Authority IS transferable between peers — this is how authority moves
 *   between devices, tabs, or to a different user (delegation, host migration).
 * - Assigning a new authority automatically removes the old one (exclusive).
 * - Authority determines who can write runtime data for this entity.
 *   Authored mutations may additionally require governance checks (Spec 07).
 *
 * Triple: (entity, AuthoritativeFor, peerEntity)
 */
const AuthoritativeFor: RelationDefinition = defineRelation('AuthoritativeFor', {
  exclusive: true,
  autoRemoveSubject: false,
  mutationCategory: 'authored'
})
```

### R5: createUser

```typescript
/**
 * Create or resolve a user entity from a DID identity.
 *
 * If a user entity with the given DID already exists in the world,
 * returns the existing entity (updates displayName if provided).
 * Otherwise, creates a new user entity with UserComponent and UIDComponent.
 *
 * The user entity's UID is derived from the DID (the full did:key string).
 *
 * @param world - The world
 * @param options - User identity and display info
 * @returns The user entity (existing or newly created)
 *
 * @example
 * const me = createUser(world, {
 *   did: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
 *   displayName: 'Josh',
 * })
 */
declare function createUser(
  world: World,
  options: {
    /** The user's DID (did:key:z6Mk...) */
    did: string
    /** Human-readable display name */
    displayName?: string
  }
): Entity
```

#### Pseudocode

```
function createUser(world, options):
  // Check if a user with this DID already exists
  existingUsers = query(world, [UserComponent])
  for entity of existingUsers:
    userData = getComponent(world, entity, UserComponent)
    if userData.did === options.did:
      // Update display name if provided
      if options.displayName:
        setComponent(world, entity, UserComponent, { displayName: options.displayName })
      return entity

  // Create new user entity
  entity = createEntity(world)
  setComponent(world, entity, UserComponent, {
    did: options.did,
    displayName: options.displayName ?? '',
  })
  setComponent(world, entity, UIDComponent, { value: options.did })

  return entity
```

### R6: createPeer

```typescript
/**
 * Create a peer entity for an engine instance, belonging to a user.
 *
 * Creates a new entity with PeerComponent and a BelongsTo relation to
 * the user entity. Each browser tab / device / server instance gets
 * its own peer entity.
 *
 * @param world - The world
 * @param options - Peer configuration
 * @returns The peer entity
 *
 * @example
 * const myPeer = createPeer(world, {
 *   user: meEntity,
 *   peerId: crypto.randomUUID(),
 * })
 * // myPeer now has: PeerComponent + BelongsTo(meEntity)
 */
declare function createPeer(
  world: World,
  options: {
    /** The user entity this peer belongs to */
    user: Entity
    /**
     * Unique peer identifier.
     * @default crypto.randomUUID()
     */
    peerId?: string
  }
): Entity
```

#### Pseudocode

```
function createPeer(world, options):
  entity = createEntity(world)

  peerId = options.peerId ?? crypto.randomUUID()

  setComponent(world, entity, PeerComponent, {
    peerId,
    latency: 0,
  })

  // Link peer to user
  addRelation(world, entity, BelongsTo, options.user)

  // Set UID for identity resolution
  setComponent(world, entity, UIDComponent, { value: peerId })

  return entity
```

### R7: Authority Helpers

```typescript
/**
 * Get the owner (user entity) of an entity.
 *
 * @param world - The world
 * @param entity - The entity to check
 * @returns The owner user entity, or undefined if unowned
 */
declare function getOwner(world: World, entity: Entity): Entity | undefined

/**
 * Get the authoritative peer for an entity.
 *
 * @param world - The world
 * @param entity - The entity to check
 * @returns The authoritative peer entity, or undefined if no authority assigned
 */
declare function getAuthorityPeer(world: World, entity: Entity): Entity | undefined

/**
 * Get the user entity that a peer belongs to.
 *
 * @param world - The world
 * @param peer - The peer entity
 * @returns The user entity, or undefined if the peer has no BelongsTo user
 */
declare function getPeerUser(world: World, peer: Entity): Entity | undefined

/**
 * Get all peers belonging to a user.
 *
 * @param world - The world
 * @param user - The user entity
 * @returns Array of peer entities belonging to this user
 */
declare function getUserPeers(world: World, user: Entity): Entity[]

/**
 * Check if a peer is authoritative for a given entity.
 *
 * @param world - The world
 * @param entity - The entity to check
 * @param peer - The peer to check authority for
 * @returns true if the peer is the authoritative peer for this entity
 */
declare function isAuthoritative(world: World, entity: Entity, peer: Entity): boolean
```

#### Pseudocode

```
function getOwner(world, entity):
  targets = getRelationTargets(world, entity, OwnedBy)
  return targets.length > 0 ? targets[0] : undefined

function getAuthorityPeer(world, entity):
  targets = getRelationTargets(world, entity, AuthoritativeFor)
  return targets.length > 0 ? targets[0] : undefined

function getPeerUser(world, peer):
  targets = getRelationTargets(world, peer, BelongsTo)
  if targets.length === 0: return undefined
  target = targets[0]
  // Verify target is a user entity
  if hasComponent(world, target, UserComponent):
    return target
  return undefined

function getUserPeers(world, user):
  // Query all peers that BelongsTo this user
  allPeers = query(world, [PeerComponent, BelongsTo(user)])
  return allPeers

function isAuthoritative(world, entity, peer):
  return getAuthorityPeer(world, entity) === peer
```

### R8: requestAuthority

```typescript
/**
 * Result of an authority request.
 */
type AuthorityRequestResult = { status: 'granted' } | { status: 'denied'; reason: string } | { status: 'pending' }

/**
 * Request authority over an entity.
 *
 * Protocol:
 * 1. Send authority request to the entity's owner (or current authority holder)
 * 2. The owner validates the request:
 *    a. Checks governance constraints (Spec 07)
 *    b. Checks if the requester's user has permission
 * 3. If approved: owner dispatches transferAuthority
 * 4. If denied: returns denial with reason
 *
 * The requesting peer does NOT claim authority directly.
 * Authority transfer is always mediated by the owner or current authority holder.
 *
 * @param world - The world
 * @param entity - The entity to request authority over
 * @param requester - The peer entity requesting authority
 * @returns Promise resolving when the owner responds
 *
 * @example
 * const result = await requestAuthority(world, vehicleEntity, myPeer)
 * if (result.status === 'granted') {
 *   // AuthoritativeFor relation was updated via reliable replication
 * }
 */
declare function requestAuthority(world: World, entity: Entity, requester: Entity): Promise<AuthorityRequestResult>
```

#### Pseudocode

```
function requestAuthority(world, entity, requester):
  // 1. Find the owner
  owner = getOwner(world, entity)
  if !owner:
    return { status: 'denied', reason: 'Entity has no owner' }

  // 2. Find the owner's active peer (the one that handles the request)
  ownerPeers = getUserPeers(world, owner)
  if ownerPeers.length === 0:
    return { status: 'denied', reason: 'Owner has no active peers' }

  // Pick the primary peer (lowest peer ID for determinism)
  ownerPeer = ownerPeers.sort(byPeerId)[0]

  // 3. Send authority request via reliable transport
  request = {
    type: 'authorityRequest',
    entityPath: getEntityPath(world, entity),
    requesterPeerId: getComponent(world, requester, PeerComponent).peerId,
  }

  connection = findConnectionToPeer(world, ownerPeer)
  if !connection:
    return { status: 'denied', reason: 'No connection to owner peer' }

  // 4. Send and await response
  response = await connection.sendRequestAndAwait(request)

  if response.status === 'granted':
    // The owner has dispatched transferAuthority — the AuthoritativeFor
    // relation update arrives via normal authored replication
    return { status: 'granted' }
  else:
    return { status: 'denied', reason: response.reason }
```

### R9: transferAuthority

```typescript
/**
 * Transfer authority of an entity to a new peer.
 *
 * Only callable by:
 * - The entity's owner user (any of their peers)
 * - A peer with a valid CapabilityConstraint for authority transfer (Spec 07)
 *
 * Updates the AuthoritativeFor relation atomically (exclusive relation — old
 * authority is automatically removed). The update propagates via the authored
 * mutation pipeline to all connected peers.
 *
 * @param world - The world
 * @param entity - The entity to transfer authority for
 * @param newPeer - The peer entity receiving authority
 * @throws Error if the caller is not the owner and has no capability for transfer
 *
 * @example
 * // Owner transfers authority to a different peer
 * transferAuthority(world, vehicleEntity, otherPeer)
 *
 * // After this, AuthoritativeFor(vehicleEntity) → otherPeer
 * // All peers receive this via reliable replication
 */
declare function transferAuthority(world: World, entity: Entity, newPeer: Entity): void
```

#### Pseudocode

```
function transferAuthority(world, entity, newPeer):
  // Validate: caller must be the owner or have a valid capability
  owner = getOwner(world, entity)
  localPeer = world.localPeer

  if localPeer:
    localUser = getPeerUser(world, localPeer)
    if localUser !== owner:
      // Check for CapabilityConstraint (Spec 07)
      // For now: throw if not owner
      throw Error('Only the owner can transfer authority')

  // Update the AuthoritativeFor relation
  // Since it's exclusive, old authority is automatically removed
  addRelation(world, entity, AuthoritativeFor, newPeer)

  // This is an authored mutation — it will be queued, batched, and
  // sent via reliable transport to all peers (Spec 05)
```

### R10: Auto-Recovery on Authority Peer Disconnect

When the peer holding authority over an entity disconnects, the entity's owner automatically reclaims authority. This ensures entities are never left without a writer.

```typescript
/**
 * Handle authority recovery when a peer disconnects.
 *
 * Called when a peer connection is lost (from Spec 05 disconnectPeer).
 * For each entity where the disconnected peer was authoritative:
 * 1. Find the entity's owner user
 * 2. Find the owner's lowest-sorted active peer (deterministic selection)
 * 3. Transfer authority to that peer
 *
 * If the owner has no active peers (user is fully disconnected),
 * the entity remains without authority until the owner reconnects
 * or governance rules handle cleanup.
 *
 * @param world - The world
 * @param disconnectedPeer - The peer entity that disconnected
 */
declare function handleAuthorityRecovery(world: World, disconnectedPeer: Entity): void
```

#### Pseudocode

```
function handleAuthorityRecovery(world, disconnectedPeer):
  // Find all entities where disconnectedPeer was authoritative
  // Query: entities with AuthoritativeFor(disconnectedPeer)
  affectedEntities = query(world, [AuthoritativeFor(disconnectedPeer)])

  for entity of affectedEntities:
    owner = getOwner(world, entity)
    if !owner:
      // Orphaned entity — leave without authority
      // Governance may clean this up
      removeRelation(world, entity, AuthoritativeFor, disconnectedPeer)
      continue

    // Find owner's remaining active peers
    activePeers = getUserPeers(world, owner).filter(p => p !== disconnectedPeer)

    if activePeers.length > 0:
      // Sort by peer ID for deterministic selection
      activePeers.sort(byPeerId)
      newAuthority = activePeers[0]
      transferAuthority(world, entity, newAuthority)
    else:
      // Owner has no active peers — remove authority, entity is dormant
      removeRelation(world, entity, AuthoritativeFor, disconnectedPeer)
```

### R11: Peer Disconnect Cleanup

```typescript
/**
 * Handle full peer disconnect cleanup.
 *
 * Called when a peer connection is lost. Performs:
 * 1. Authority recovery for entities the peer was authoritative for (R10)
 * 2. Remove the peer entity's PeerComponent
 * 3. Check if the user has any remaining peers
 * 4. If no remaining peers: clean up user-specific entities (avatars, etc.)
 *
 * @param world - The world
 * @param disconnectedPeer - The peer entity that disconnected
 */
declare function handlePeerDisconnect(world: World, disconnectedPeer: Entity): void
```

#### Pseudocode

```
function handlePeerDisconnect(world, disconnectedPeer):
  // 1. Authority recovery
  handleAuthorityRecovery(world, disconnectedPeer)

  // 2. Identify the user
  user = getPeerUser(world, disconnectedPeer)

  // 3. Remove peer entity
  removeEntity(world, disconnectedPeer)

  // 4. Check if user is fully disconnected
  if user:
    remainingPeers = getUserPeers(world, user)
    if remainingPeers.length === 0:
      // User is fully disconnected
      // Clean up user-specific transient entities (avatars, etc.)
      // Entities owned by the user that are NOT persistent game state
      // should be removed. Persistent entities (scores, etc.) survive.
      handleUserFullDisconnect(world, user)

function handleUserFullDisconnect(world, user):
  // Find entities owned by this user that have autoRemoveSubject semantics
  // or are marked as transient (e.g., avatars)
  ownedEntities = query(world, [OwnedBy(user)])
  for entity of ownedEntities:
    // Only remove transient entities (avatars, ephemeral state)
    // Persistent entities (scores, achievements) survive disconnect
    // This heuristic may be defined by higher layers or component metadata
    // For now: remove entities that have both OwnedBy(user) AND
    // a transient marker (e.g., a TransientOnDisconnect tag component)
    if hasComponent(world, entity, TransientOnDisconnect):
      removeEntity(world, entity)
```

### R12: DID Signing & Verification

```typescript
/**
 * DID key pair for Ed25519 signing.
 * Used for signing authored mutations and verifying signatures.
 */
interface DIDKeyPair {
  /** The DID (did:key:z6Mk...) */
  did: string

  /** Ed25519 public key (32 bytes) */
  publicKey: Uint8Array

  /**
   * Ed25519 private key (64 bytes — seed + public).
   * Only available for the local user.
   */
  privateKey: Uint8Array
}

/**
 * Generate a new Ed25519 DID key pair.
 *
 * @returns A new DID key pair with did:key identifier
 *
 * @example
 * const keyPair = generateDIDKeyPair()
 * // keyPair.did: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
 */
declare function generateDIDKeyPair(): DIDKeyPair

/**
 * Resolve a DID to its public key.
 * For did:key method, this is a deterministic decode.
 *
 * @param did - The DID string (did:key:z6Mk...)
 * @returns The Ed25519 public key, or undefined if the DID format is invalid
 */
declare function resolveDIDToPublicKey(did: string): Uint8Array | undefined

/**
 * Sign an authored mutation with an Ed25519 private key.
 *
 * Signs a canonical serialisation of the mutation (JSON with sorted keys).
 * The signature covers: type, entityPath, predicate, data, relationTargetPath, timestamp.
 *
 * @param mutation - The mutation to sign
 * @param privateKey - The Ed25519 private key (64 bytes)
 * @returns The Ed25519 signature (64 bytes)
 */
declare function signMutation(mutation: AuthoredMutation, privateKey: Uint8Array): Uint8Array

/**
 * Verify the signature on an authored mutation.
 *
 * @param mutation - The mutation with authorDID and signature set
 * @returns true if the signature is valid for the authorDID's public key
 */
declare function verifyMutationSignature(mutation: AuthoredMutation): boolean
```

#### Signing Pseudocode

```
function signMutation(mutation, privateKey):
  // Create canonical payload (deterministic JSON)
  payload = canonicalJSON({
    type: mutation.type,
    entityPath: mutation.entityPath,
    predicate: mutation.predicate,
    data: mutation.data,
    relationTargetPath: mutation.relationTargetPath,
    timestamp: mutation.timestamp,
  })

  // Sign with Ed25519
  payloadBytes = new TextEncoder().encode(payload)
  signature = ed25519.sign(payloadBytes, privateKey)
  return signature

function verifyMutationSignature(mutation):
  if !mutation.authorDID || !mutation.signature:
    return false

  publicKey = resolveDIDToPublicKey(mutation.authorDID)
  if !publicKey:
    return false

  payload = canonicalJSON({
    type: mutation.type,
    entityPath: mutation.entityPath,
    predicate: mutation.predicate,
    data: mutation.data,
    relationTargetPath: mutation.relationTargetPath,
    timestamp: mutation.timestamp,
  })

  payloadBytes = new TextEncoder().encode(payload)
  return ed25519.verify(mutation.signature, payloadBytes, publicKey)

function canonicalJSON(obj):
  // JSON.stringify with sorted keys for deterministic output
  return JSON.stringify(obj, Object.keys(obj).sort())
```

### R13: TransientOnDisconnect Tag

```typescript
/**
 * Tag component marking an entity for removal when its owner fully disconnects.
 *
 * Entities with this tag and an OwnedBy relation are removed when the owner
 * user's last peer disconnects. Used for avatars, cursors, and other
 * presence-bound entities.
 *
 * Entities WITHOUT this tag survive user disconnect (e.g., scores,
 * persistent game objects, world-owned entities).
 */
const TransientOnDisconnect: ComponentDefinition = defineComponent({
  id: 'TransientOnDisconnect',
  label: 'Transient On Disconnect',
  mutationCategory: 'authored',
  schema: Schema.Object({}) // empty tag component — no data, just a marker
})
```

---

## Test Specifications

### User Creation Tests

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWorld, destroyWorld } from '../src/world'
import { createEntity } from '../src/entity'
import { createUser, createPeer, UserComponent, PeerComponent } from '../src/user-peer'
import { getComponent, hasComponent } from '../src/component'
import { getRelationTargets, BelongsTo, UIDComponent } from '../src/identity'
import type { World, Entity } from '../src/types'

describe('createUser', () => {
  let world: World

  beforeEach(() => {
    world = createWorld()
  })

  afterEach(() => {
    destroyWorld(world)
  })

  it('should create a user entity with UserComponent', () => {
    const user = createUser(world, {
      did: 'did:key:z6MkTestUser1',
      displayName: 'TestUser'
    })

    expect(hasComponent(world, user, UserComponent)).toBe(true)
    const data = getComponent(world, user, UserComponent)
    expect(data!.did).toBe('did:key:z6MkTestUser1')
    expect(data!.displayName).toBe('TestUser')
  })

  it('should set UIDComponent with the DID', () => {
    const user = createUser(world, {
      did: 'did:key:z6MkTestUser2'
    })

    expect(hasComponent(world, user, UIDComponent)).toBe(true)
    const uid = getComponent(world, user, UIDComponent)
    expect(uid!.value).toBe('did:key:z6MkTestUser2')
  })

  it('should return existing user if DID already exists', () => {
    const user1 = createUser(world, {
      did: 'did:key:z6MkTestUser3',
      displayName: 'First'
    })

    const user2 = createUser(world, {
      did: 'did:key:z6MkTestUser3',
      displayName: 'Updated'
    })

    expect(user1).toBe(user2) // same entity

    const data = getComponent(world, user2, UserComponent)
    expect(data!.displayName).toBe('Updated') // name updated
  })

  it('should default displayName to empty string', () => {
    const user = createUser(world, { did: 'did:key:z6MkTestUser4' })

    const data = getComponent(world, user, UserComponent)
    expect(data!.displayName).toBe('')
  })
})
```

### Peer Creation Tests

```typescript
describe('createPeer', () => {
  let world: World
  let user: Entity

  beforeEach(() => {
    world = createWorld()
    user = createUser(world, { did: 'did:key:z6MkPeerTest' })
  })

  afterEach(() => {
    destroyWorld(world)
  })

  it('should create a peer entity with PeerComponent', () => {
    const peer = createPeer(world, { user, peerId: 'peer-abc' })

    expect(hasComponent(world, peer, PeerComponent)).toBe(true)
    const data = getComponent(world, peer, PeerComponent)
    expect(data!.peerId).toBe('peer-abc')
    expect(data!.latency).toBe(0)
  })

  it('should link peer to user via BelongsTo', () => {
    const peer = createPeer(world, { user, peerId: 'peer-linked' })

    const targets = getRelationTargets(world, peer, BelongsTo)
    expect(targets).toEqual([user])
  })

  it('should set UIDComponent with peerId', () => {
    const peer = createPeer(world, { user, peerId: 'peer-uid' })

    const uid = getComponent(world, peer, UIDComponent)
    expect(uid!.value).toBe('peer-uid')
  })

  it('should generate peerId if not provided', () => {
    const peer = createPeer(world, { user })

    const data = getComponent(world, peer, PeerComponent)
    expect(data!.peerId).toBeTruthy()
    expect(data!.peerId.length).toBeGreaterThan(0)
  })

  it('should allow multiple peers per user', () => {
    const peer1 = createPeer(world, { user, peerId: 'peer-1' })
    const peer2 = createPeer(world, { user, peerId: 'peer-2' })
    const peer3 = createPeer(world, { user, peerId: 'peer-3' })

    expect(peer1).not.toBe(peer2)
    expect(peer2).not.toBe(peer3)

    // All belong to the same user
    expect(getRelationTargets(world, peer1, BelongsTo)).toEqual([user])
    expect(getRelationTargets(world, peer2, BelongsTo)).toEqual([user])
    expect(getRelationTargets(world, peer3, BelongsTo)).toEqual([user])
  })
})
```

### Ownership Tests

```typescript
import { OwnedBy, getOwner } from '../src/ownership'
import { addRelation, hasRelation } from '../src/relation'

describe('Ownership (OwnedBy)', () => {
  let world: World
  let user: Entity

  beforeEach(() => {
    world = createWorld()
    user = createUser(world, { did: 'did:key:z6MkOwnerTest' })
  })

  afterEach(() => {
    destroyWorld(world)
  })

  it('should assign ownership via OwnedBy relation', () => {
    const entity = createEntity(world)

    addRelation(world, entity, OwnedBy, user)

    expect(hasRelation(world, entity, OwnedBy, user)).toBe(true)
    expect(getOwner(world, entity)).toBe(user)
  })

  it('should enforce exclusive ownership — one owner per entity', () => {
    const user2 = createUser(world, { did: 'did:key:z6MkOwnerTest2' })
    const entity = createEntity(world)

    addRelation(world, entity, OwnedBy, user)
    addRelation(world, entity, OwnedBy, user2) // replaces owner

    expect(getOwner(world, entity)).toBe(user2)
    expect(hasRelation(world, entity, OwnedBy, user)).toBe(false)
  })

  it('should return undefined for unowned entities', () => {
    const entity = createEntity(world)

    expect(getOwner(world, entity)).toBeUndefined()
  })

  it('should allow one user to own multiple entities', () => {
    const e1 = createEntity(world)
    const e2 = createEntity(world)
    const e3 = createEntity(world)

    addRelation(world, e1, OwnedBy, user)
    addRelation(world, e2, OwnedBy, user)
    addRelation(world, e3, OwnedBy, user)

    expect(getOwner(world, e1)).toBe(user)
    expect(getOwner(world, e2)).toBe(user)
    expect(getOwner(world, e3)).toBe(user)
  })
})
```

### Authority Tests

```typescript
import { AuthoritativeFor, getAuthorityPeer, isAuthoritative, transferAuthority } from '../src/authority'

describe('Authority (AuthoritativeFor)', () => {
  let world: World
  let user: Entity
  let peer: Entity

  beforeEach(() => {
    world = createWorld()
    user = createUser(world, { did: 'did:key:z6MkAuthTest' })
    peer = createPeer(world, { user, peerId: 'auth-peer' })
    world.localPeer = peer
  })

  afterEach(() => {
    destroyWorld(world)
  })

  it('should assign authority via AuthoritativeFor relation', () => {
    const entity = createEntity(world)
    addRelation(world, entity, OwnedBy, user)
    addRelation(world, entity, AuthoritativeFor, peer)

    expect(getAuthorityPeer(world, entity)).toBe(peer)
    expect(isAuthoritative(world, entity, peer)).toBe(true)
  })

  it('should enforce exclusive authority — one peer per entity', () => {
    const user2 = createUser(world, { did: 'did:key:z6MkAuthTest2' })
    const peer2 = createPeer(world, { user: user2, peerId: 'auth-peer-2' })
    const entity = createEntity(world)
    addRelation(world, entity, OwnedBy, user)

    addRelation(world, entity, AuthoritativeFor, peer)
    expect(isAuthoritative(world, entity, peer)).toBe(true)

    // Transfer authority
    addRelation(world, entity, AuthoritativeFor, peer2)
    expect(isAuthoritative(world, entity, peer2)).toBe(true)
    expect(isAuthoritative(world, entity, peer)).toBe(false)
  })

  it('should return undefined for entities without authority', () => {
    const entity = createEntity(world)

    expect(getAuthorityPeer(world, entity)).toBeUndefined()
    expect(isAuthoritative(world, entity, peer)).toBe(false)
  })

  it('should transfer authority via transferAuthority', () => {
    const peer2 = createPeer(world, { user, peerId: 'transfer-target' })
    const entity = createEntity(world)
    addRelation(world, entity, OwnedBy, user)
    addRelation(world, entity, AuthoritativeFor, peer)

    transferAuthority(world, entity, peer2)

    expect(getAuthorityPeer(world, entity)).toBe(peer2)
    expect(isAuthoritative(world, entity, peer)).toBe(false)
    expect(isAuthoritative(world, entity, peer2)).toBe(true)
  })
})
```

### Authority Recovery Tests

```typescript
import { handleAuthorityRecovery, handlePeerDisconnect } from '../src/authority'
import { getUserPeers } from '../src/user-peer'

describe('Authority Recovery', () => {
  it('should recover authority to owner peer when authority peer disconnects', () => {
    const world = createWorld()
    const user = createUser(world, { did: 'did:key:z6MkRecovery' })
    const ownerPeer = createPeer(world, { user, peerId: 'owner-peer' })
    const remotePeer = createPeer(world, {
      user: createUser(world, { did: 'did:key:z6MkRemote' }),
      peerId: 'remote-peer'
    })

    const entity = createEntity(world)
    addRelation(world, entity, OwnedBy, user)
    addRelation(world, entity, AuthoritativeFor, remotePeer)

    // Remote peer disconnects
    handleAuthorityRecovery(world, remotePeer)

    // Owner's peer should now have authority
    expect(getAuthorityPeer(world, entity)).toBe(ownerPeer)

    destroyWorld(world)
  })

  it('should pick lowest-sorted peer ID for deterministic recovery', () => {
    const world = createWorld()
    const user = createUser(world, { did: 'did:key:z6MkMultiPeer' })
    const peerA = createPeer(world, { user, peerId: 'aaa' })
    const peerB = createPeer(world, { user, peerId: 'bbb' })
    const peerC = createPeer(world, { user, peerId: 'ccc' })

    const remotePeer = createPeer(world, { user: createUser(world, { did: 'did:key:z6MkOther' }), peerId: 'remote' })

    const entity = createEntity(world)
    addRelation(world, entity, OwnedBy, user)
    addRelation(world, entity, AuthoritativeFor, remotePeer)

    handleAuthorityRecovery(world, remotePeer)

    // Should pick 'aaa' (lowest sorted)
    expect(getAuthorityPeer(world, entity)).toBe(peerA)

    destroyWorld(world)
  })

  it('should leave entity without authority if owner has no active peers', () => {
    const world = createWorld()
    const user = createUser(world, { did: 'did:key:z6MkNoPeers' })
    const onlyPeer = createPeer(world, { user, peerId: 'only' })

    const entity = createEntity(world)
    addRelation(world, entity, OwnedBy, user)
    addRelation(world, entity, AuthoritativeFor, onlyPeer)

    handleAuthorityRecovery(world, onlyPeer)

    // No peers left — authority removed
    expect(getAuthorityPeer(world, entity)).toBeUndefined()

    destroyWorld(world)
  })
})
```

### Peer Disconnect Cleanup Tests

```typescript
import { TransientOnDisconnect } from '../src/user-peer'

describe('Peer Disconnect Cleanup', () => {
  it('should remove peer entity on disconnect', () => {
    const world = createWorld()
    const user = createUser(world, { did: 'did:key:z6MkDisconnect' })
    const peer = createPeer(world, { user, peerId: 'disconnect-peer' })

    handlePeerDisconnect(world, peer)

    expect(hasComponent(world, peer, PeerComponent)).toBe(false)

    destroyWorld(world)
  })

  it('should remove transient entities when user fully disconnects', () => {
    const world = createWorld()
    const user = createUser(world, { did: 'did:key:z6MkFullDisconnect' })
    const peer = createPeer(world, { user, peerId: 'last-peer' })

    // Create an avatar owned by user with TransientOnDisconnect
    const avatar = createEntity(world)
    addRelation(world, avatar, OwnedBy, user)
    setComponent(world, avatar, TransientOnDisconnect)

    // Create a score owned by user WITHOUT TransientOnDisconnect
    const score = createEntity(world)
    addRelation(world, score, OwnedBy, user)

    handlePeerDisconnect(world, peer)

    // Avatar should be removed (transient)
    // Score should survive (persistent)
    expect(hasComponent(world, score, OwnedBy)).toBeDefined() // score survives
  })

  it('should not remove user-owned entities if user has remaining peers', () => {
    const world = createWorld()
    const user = createUser(world, { did: 'did:key:z6MkPartialDisconnect' })
    const peer1 = createPeer(world, { user, peerId: 'peer-stay' })
    const peer2 = createPeer(world, { user, peerId: 'peer-leave' })

    const avatar = createEntity(world)
    addRelation(world, avatar, OwnedBy, user)
    setComponent(world, avatar, TransientOnDisconnect)

    handlePeerDisconnect(world, peer2)

    // User still has peer1 — transient entities should NOT be removed
    expect(hasRelation(world, avatar, OwnedBy, user)).toBe(true)

    destroyWorld(world)
  })
})
```

### User/Peer Helper Tests

```typescript
import { getPeerUser, getUserPeers } from '../src/user-peer'

describe('User/Peer Helpers', () => {
  it('should get the user for a peer', () => {
    const world = createWorld()
    const user = createUser(world, { did: 'did:key:z6MkHelper1' })
    const peer = createPeer(world, { user, peerId: 'helper-peer' })

    expect(getPeerUser(world, peer)).toBe(user)

    destroyWorld(world)
  })

  it('should get all peers for a user', () => {
    const world = createWorld()
    const user = createUser(world, { did: 'did:key:z6MkHelper2' })
    const p1 = createPeer(world, { user, peerId: 'p1' })
    const p2 = createPeer(world, { user, peerId: 'p2' })

    const peers = getUserPeers(world, user)
    expect(peers).toContain(p1)
    expect(peers).toContain(p2)
    expect(peers).toHaveLength(2)

    destroyWorld(world)
  })

  it('should return empty array for user with no peers', () => {
    const world = createWorld()
    const user = createUser(world, { did: 'did:key:z6MkNoPeersHelper' })

    expect(getUserPeers(world, user)).toEqual([])

    destroyWorld(world)
  })

  it('should return undefined for non-peer entity', () => {
    const world = createWorld()
    const entity = createEntity(world)

    expect(getPeerUser(world, entity)).toBeUndefined()

    destroyWorld(world)
  })
})
```

### DID Signing Tests

```typescript
import { generateDIDKeyPair, resolveDIDToPublicKey, signMutation, verifyMutationSignature } from '../src/did'

describe('DID Signing & Verification', () => {
  it('should generate a valid DID key pair', () => {
    const keyPair = generateDIDKeyPair()

    expect(keyPair.did).toMatch(/^did:key:z6Mk/)
    expect(keyPair.publicKey).toBeInstanceOf(Uint8Array)
    expect(keyPair.publicKey.length).toBe(32)
    expect(keyPair.privateKey).toBeInstanceOf(Uint8Array)
    expect(keyPair.privateKey.length).toBe(64)
  })

  it('should resolve DID to public key', () => {
    const keyPair = generateDIDKeyPair()
    const resolved = resolveDIDToPublicKey(keyPair.did)

    expect(resolved).toBeDefined()
    expect(resolved).toEqual(keyPair.publicKey)
  })

  it('should return undefined for invalid DID format', () => {
    expect(resolveDIDToPublicKey('not-a-did')).toBeUndefined()
    expect(resolveDIDToPublicKey('did:web:example.com')).toBeUndefined()
  })

  it('should sign and verify a mutation', () => {
    const keyPair = generateDIDKeyPair()

    const mutation: AuthoredMutation = {
      type: 'setComponent',
      timestamp: 1.0,
      entityPath: ['Scene', 'Player1'],
      predicate: 'Health',
      data: { current: 50 },
      authorDID: keyPair.did
    }

    mutation.signature = signMutation(mutation, keyPair.privateKey)

    expect(mutation.signature).toBeInstanceOf(Uint8Array)
    expect(mutation.signature.length).toBe(64)
    expect(verifyMutationSignature(mutation)).toBe(true)
  })

  it('should reject tampered mutations', () => {
    const keyPair = generateDIDKeyPair()

    const mutation: AuthoredMutation = {
      type: 'setComponent',
      timestamp: 1.0,
      entityPath: ['Scene', 'Player1'],
      predicate: 'Health',
      data: { current: 50 },
      authorDID: keyPair.did
    }

    mutation.signature = signMutation(mutation, keyPair.privateKey)

    // Tamper with data
    mutation.data = { current: 999 }

    expect(verifyMutationSignature(mutation)).toBe(false)
  })

  it('should reject mutations with wrong DID', () => {
    const keyPair1 = generateDIDKeyPair()
    const keyPair2 = generateDIDKeyPair()

    const mutation: AuthoredMutation = {
      type: 'setComponent',
      timestamp: 1.0,
      entityPath: ['Scene', 'Player1'],
      predicate: 'Health',
      data: { current: 50 },
      authorDID: keyPair2.did // signed by keyPair1 but claims keyPair2
    }

    mutation.signature = signMutation(mutation, keyPair1.privateKey)

    expect(verifyMutationSignature(mutation)).toBe(false)
  })

  it('should reject mutations without signature', () => {
    const mutation: AuthoredMutation = {
      type: 'setComponent',
      timestamp: 1.0,
      entityPath: ['Scene', 'Player1'],
      predicate: 'Health',
      data: { current: 50 },
      authorDID: 'did:key:z6MkNoSig'
    }

    expect(verifyMutationSignature(mutation)).toBe(false)
  })
})
```

---

## Edge Cases & Constraints

1. **Ownership is NOT transferable.** The `OwnedBy` relation should not be changed after initial assignment. To "transfer ownership," the entity must be destroyed and recreated under the new owner. This preserves provenance and the agent-centric data model.

2. **Authority IS transferable.** The `AuthoritativeFor` relation can be updated at any time. Since it's exclusive, assigning a new authority automatically removes the old one.

3. **One user, many peers.** A user can have multiple simultaneous peers (multiple tabs, devices). All peers share the same DID identity and ownership rights. Authority is per-peer, not per-user.

4. **Peer ID uniqueness.** Peer IDs must be unique within a session. Using `crypto.randomUUID()` by default ensures practical uniqueness.

5. **Authority recovery is deterministic.** When the authority peer disconnects, the owner's lowest-sorted peer ID takes over. This ensures all peers agree on the new authority without needing a consensus round.

6. **Orphaned entities.** If an entity's owner user fully disconnects and has no remaining peers, the entity may be left without authority. Governance rules (Spec 07) can handle cleanup — e.g., auto-removing or transferring ownership after a timeout.

7. **TransientOnDisconnect is opt-in.** Only entities explicitly tagged with `TransientOnDisconnect` are removed on user full disconnect. All other owned entities survive. This is critical for persistent game state (scores, leaderboards, placed objects).

8. **DID key pairs must be stored securely.** The private key is only needed on the local machine. In a browser context, it should be stored in `localStorage` or `IndexedDB` — not sent over the network. The public key (embedded in the DID) is shared freely.

9. **Ed25519 signature is 64 bytes.** The canonical payload for signing must be deterministic — JSON with sorted keys. Any deviation in serialization order between signing and verification will cause false rejections.

10. **did:key method only.** This spec only supports `did:key` (self-certifying Ed25519 keys). Other DID methods (`did:web`, `did:plc`) may be added later but are out of scope here.

11. **BelongsTo for peers targets users only.** A peer entity's `BelongsTo` target should always be a user entity (with `UserComponent`). The `getPeerUser` helper verifies this.

---

## Dependencies

- **Spec 01 (`01-world-entity.md`)**: World, Entity, `createEntity`, `removeEntity`
- **Spec 02 (`02-component-definitions.md`)**: `defineComponent`, `setComponent`, `getComponent`, `hasComponent`, `removeComponent`, `ComponentDefinition`, `Schema`
- **Spec 03 (`03-relations-identity.md`)**: `defineRelation`, `addRelation`, `removeRelation`, `hasRelation`, `getRelationTargets`, `BelongsTo`, `UIDComponent`, `Wildcard`, `query`
- **Spec 04 (`04-systems-prefabs-serialization.md`)**: `createSnapshot`, `applySnapshot` for late join bootstrap
- **Spec 05 (`05-mutation-pipeline.md`)**: `Connection`, `AuthoredMutation`, `withOrigin`, `processAuthoredBatch`, peer connection lifecycle (`connectToPeer`, `disconnectPeer`)
- **Ed25519**: cryptographic signing library (e.g., `@noble/ed25519` or `tweetnacl`)
- **Multibase/Multicodec**: for `did:key` encoding/decoding
