# Spec 05: Mutation Pipeline & Transport

## Project & Architecture Context

**Connection Engine** is a semantic spatial web engine — a multiplayer-first, data-driven TypeScript engine for real-time spatial experiences built on web standards.

**Core design principles:**

1. **Everything is an entity.** Users, avatars, scores, quests, factions, inventories — only engine runtime bindings live outside the ECS.
2. **Fewest abstractions.** One ECS/change model serves realtime replication, authority, validation, and persistence integrations.
3. **Component-level mutation categories.** Network behaviour is defined per-component as authored (reliable, governance-validated, event-sourced), runtime (binary, authority-checked, ephemeral), or local (never replicated).
4. **Semantic graph runtime.** The ECS is a graph of typed relationships — components are schemas, relationships are predicates, queries are pattern matching.

**Tech stack:** TypeScript, bitECS v4, TypeBox, Vitest

**Dependency chain:** This is Spec 05 (Tier 3). Depends on:

- `01-world-entity.md` — World, Entity, time state
- `02-component-definitions.md` — `defineComponent`, `setComponent`, `ComponentDefinition`, `MutationCategory`, observers
- `03-relations-identity.md` — `defineRelation`, `addRelation`, `BelongsTo`, `UIDComponent`, identity path resolution
- `04-systems-prefabs-serialization.md` — `executeFrame`, system phases, `createRuntimeSerializer`/`createRuntimeDeserializer`, `createSnapshot`/`applySnapshot`, `EntityIdMap`

Depended on by:

- `06-users-peers-authority.md` — uses connection lifecycle, origin tags, transport for authority transfer
- `07-governance.md` — uses authored receive pipeline for governance validation enforcement

---

## Scope & Intent

This spec defines how local ECS mutations reach the network and how incoming network mutations are applied locally. It covers the full mutation pipeline from local operation to network delivery and from network receipt to local application.

Two distinct transport paths exist, driven by the component's `mutationCategory` (Spec 02):

1. **Authored transport** — for deliberate, infrequent mutations (component changes, relationship mutations, entity lifecycle). Reliable, ordered, governance-validated, event-sourced.

2. **Runtime transport** — for continuous, high-frequency data (SoA fields: positions, rotations, velocities). Binary-packed, unreliable, authority-checked only.

The mutation pipeline also defines:

- **Origin tags** — the mechanism that prevents network-received mutations from being re-broadcast
- **The authored event log** — append-only canonical state history
- **Transport configuration** — tuning tick rate, delta compression, full-sync intervals
- **Peer connection lifecycle** — how connections are established and torn down
- **Late join** — how new peers receive current world state

---

## Requirements

### R1: Mutation Origin Tags

Every local ECS operation carries an origin tag indicating whether it was locally initiated or received from the network. This is the key mechanism for preventing re-broadcast loops.

```typescript
/**
 * Origin of a mutation — determines whether it should be queued for outbound replication.
 *
 * - 'local': originated on this peer. Queued for outbound replication.
 * - 'network': received from a remote peer. NOT queued for outbound replication.
 */
type MutationOrigin = 'local' | 'network'

/**
 * Set the current mutation origin for the active operation context.
 * All setComponent/removeComponent/addRelation/removeRelation calls within
 * the callback will be tagged with the given origin.
 *
 * Default origin (outside any withOrigin call) is 'local'.
 *
 * @param origin - The origin to tag mutations with
 * @param fn - The function to execute within this origin context
 *
 * @example
 * // Network receive path — prevent re-broadcast
 * withOrigin('network', () => {
 *   setComponent(world, entity, Health, { current: 50 })
 *   // This setComponent call is tagged 'network'
 *   // → NOT queued for outbound replication
 *   // → observers still fire normally
 * })
 *
 * // Default: local origin — queued for replication
 * setComponent(world, entity, Health, { current: 75 })
 * // Tagged 'local' → queued for outbound replication
 */
declare function withOrigin<T>(origin: MutationOrigin, fn: () => T): T

/**
 * Get the current mutation origin.
 * Returns 'local' if not within a withOrigin call.
 */
declare function getCurrentOrigin(): MutationOrigin
```

#### Pseudocode

```
// Thread-local origin context (using a stack for nesting)
let originStack: MutationOrigin[] = []

function withOrigin(origin, fn):
  originStack.push(origin)
  try:
    return fn()
  finally:
    originStack.pop()

function getCurrentOrigin():
  if originStack.length === 0:
    return 'local'
  return originStack[originStack.length - 1]
```

### R2: Authored Mutation Buffer

Authored mutations are not sent immediately. They are queued in a per-world buffer during the frame, then batched and sent at end-of-tick.

```typescript
/**
 * Types of authored mutations that can be queued.
 */
type AuthoredMutationType =
  | 'setComponent'
  | 'removeComponent'
  | 'addRelation'
  | 'removeRelation'
  | 'createEntity'
  | 'removeEntity'

/**
 * A single authored mutation — one discrete state change.
 * Structured as a semantic operation with enough context for
 * remote peers to apply it unambiguously.
 */
interface AuthoredMutation {
  /** Type of mutation */
  type: AuthoredMutationType

  /** Simulation time when the mutation was queued */
  timestamp: number

  /**
   * Identity path of the target entity (from Spec 03).
   * Used for network resolution — entity IDs are never networked.
   */
  entityPath: string[]

  /**
   * Component ID (for component mutations) or relation name (for relation mutations).
   * Undefined for entity lifecycle mutations.
   */
  predicate?: string

  /**
   * Mutation payload — the data being set, or undefined for removals.
   * JSON-serializable.
   */
  data?: Record<string, unknown>

  /**
   * For relation mutations: the identity path of the target entity.
   */
  relationTargetPath?: string[]

  /**
   * DID of the authoring user (set on send, verified on receive).
   * Populated from the local user's DID identity (Spec 06).
   */
  authorDID?: string

  /**
   * Ed25519 signature of the mutation (set on send, verified on receive).
   * Populated by the signing layer (Spec 06).
   */
  signature?: Uint8Array
}

/**
 * A batch of authored mutations — sent as a single reliable message.
 * Mutations within a batch are ordered and must be applied in sequence.
 */
interface AuthoredMutationBatch {
  /** Ordered list of mutations */
  mutations: AuthoredMutation[]

  /** Peer ID of the sender */
  senderPeerId: string

  /** Batch sequence number (monotonically increasing per sender) */
  sequenceNumber: number

  /** World simulation time when the batch was created */
  timestamp: number
}

/**
 * Per-world buffer for authored mutations awaiting end-of-tick batch.
 * Mutations are appended during the frame and flushed after the Render phase.
 */
interface AuthoredMutationBuffer {
  /** Queued mutations for the current tick */
  readonly pending: AuthoredMutation[]

  /** Next batch sequence number */
  sequenceNumber: number

  /**
   * Queue a mutation for end-of-tick delivery.
   * Only called for mutations with origin 'local'.
   */
  queue(mutation: AuthoredMutation): void

  /**
   * Flush all pending mutations into a batch.
   * Clears the pending list and increments the sequence number.
   * Returns null if no mutations are pending.
   */
  flush(): AuthoredMutationBatch | null
}
```

#### Integration with setComponent/addRelation

```
// Hooked into setComponent (Spec 02) when mutationCategory is 'authored':
function setComponent(world, entity, component, data?):
  // ... existing logic from Spec 02 ...

  if component.mutationCategory === 'authored' && getCurrentOrigin() === 'local':
    world.authoredBuffer.queue({
      type: isNew ? 'setComponent' : 'setComponent',
      timestamp: world.simulationTime,
      entityPath: getEntityPath(world, entity),
      predicate: component.id,
      data: serializeComponentToJSON(world, entity, component),
    })

// Similarly for removeComponent, addRelation, removeRelation
```

### R3: End-of-Tick Batching & Delivery

After all phases complete in `executeFrame` (Spec 04), the authored mutation buffer is flushed and the batch is sent to all connected peers.

```typescript
/**
 * Flush authored mutations and send to connected peers.
 * Called automatically at the end of each executeFrame.
 *
 * 1. Flush the authored mutation buffer into a batch
 * 2. Sign the batch with the local user's DID (Spec 06)
 * 3. Send via reliable transport to all connections
 * 4. Append the batch to the local authored event log
 *
 * @param world - The world to flush
 */
declare function flushAuthoredMutations(world: World): void
```

#### Pseudocode

```
function flushAuthoredMutations(world):
  batch = world.authoredBuffer.flush()
  if batch === null:
    return  // nothing to send

  // Sign mutations (Spec 06 — if local user is set)
  if world.localUser:
    for mutation of batch.mutations:
      mutation.authorDID = world.localUser.did
      mutation.signature = sign(mutation, world.localUser.privateKey)

  // Send via reliable transport to all connections
  for connection of world.network.connections:
    connection.sendReliable(batch)

  // Append to local event log
  world.authoredEventLog.append(batch)
```

### R4: Authored Event Log

The authored event log is the canonical state history for a world. World state can be reconstructed from an initial snapshot plus replaying all authored mutations.

```typescript
/**
 * The authored event log — append-only history of all authored mutations.
 * Canonical state history: initial snapshot + event log = full world state.
 */
interface AuthoredEventLog {
  /** All recorded batches, ordered by sequence number */
  readonly batches: ReadonlyArray<AuthoredMutationBatch>

  /** Total number of individual mutations across all batches */
  readonly mutationCount: number

  /**
   * Append a batch to the log.
   * Called for both locally-originated and network-received batches.
   */
  append(batch: AuthoredMutationBatch): void

  /**
   * Get all mutations since a given simulation time.
   * Used for late-join event replay.
   *
   * @param sinceTime - Simulation time to start from (exclusive)
   * @returns Mutations after the given time
   */
  getSince(sinceTime: number): AuthoredMutation[]

  /**
   * Compact the log: create a snapshot at the current point and
   * truncate all batches before it. Used at session boundaries
   * or periodically to prevent unbounded growth.
   *
   * @param world - The world to snapshot
   * @returns The compaction snapshot
   */
  compact(world: World): Snapshot

  /** Clear the entire log (used on world destruction) */
  clear(): void
}

/**
 * Create a new empty authored event log.
 */
declare function createAuthoredEventLog(): AuthoredEventLog
```

#### Pseudocode

```
function createAuthoredEventLog():
  batches = []

  return {
    get batches(): return [...batches],
    get mutationCount(): return batches.reduce((sum, b) => sum + b.mutations.length, 0),

    append(batch):
      batches.push(batch)

    getSince(sinceTime):
      result = []
      for batch of batches:
        for mutation of batch.mutations:
          if mutation.timestamp > sinceTime:
            result.push(mutation)
      return result

    compact(world):
      snapshot = createSnapshot(world)
      batches.length = 0  // clear
      return snapshot

    clear():
      batches.length = 0
  }
```

### R5: Runtime Dirty Flags

Runtime (SoA) mutations are tracked via dirty flags rather than queued individually. At each binary transport tick, dirty entities are collected, delta-compressed, and sent.

```typescript
/**
 * Dirty flag tracker for runtime component mutations.
 * Tracks which entity+component pairs have been written since the last transport tick.
 */
interface DirtyFlagTracker {
  /**
   * Mark an entity+component pair as dirty.
   * Called internally by SoA store writes.
   */
  markDirty(entity: Entity, componentId: string): void

  /**
   * Get all dirty entities for a specific component.
   * @returns Set of entity IDs that have been modified
   */
  getDirtyEntities(componentId: string): ReadonlySet<Entity>

  /**
   * Clear dirty flags for a specific component after transport tick.
   */
  clearDirty(componentId: string): void

  /**
   * Clear all dirty flags for all components.
   */
  clearAll(): void
}

/**
 * Create a dirty flag tracker for runtime mutation tracking.
 */
declare function createDirtyFlagTracker(): DirtyFlagTracker
```

#### Integration with SoA Writes

```
// When runtime-category SoA stores are written (either via setComponent or direct access):
// The dirty flag is set automatically.

// For setComponent:
function setComponent(world, entity, component, data?):
  // ... existing logic ...

  if component.mutationCategory === 'runtime' && getCurrentOrigin() === 'local':
    world.dirtyFlags.markDirty(entity, component.id)

// For direct SoA access (hot path):
// A Proxy or write-hook on the typed arrays detects writes and sets dirty flags.
// Alternatively, systems can call markDirty explicitly after direct SoA writes:
//   world.dirtyFlags.markDirty(entity, Transform.id)
```

### R6: Binary Transport Tick

The runtime binary transport runs at a configurable tick rate (independent of the frame rate). At each transport tick, dirty entities are serialized and sent.

```typescript
/**
 * State for the runtime binary transport.
 * Managed per-world, runs at a configurable tick rate.
 */
interface RuntimeTransportState {
  /** Tick interval in milliseconds */
  tickIntervalMs: number

  /** Ticks since last full state sync */
  ticksSinceFullSync: number

  /** Full sync interval in ticks */
  fullSyncInterval: number

  /**
   * Last-sent state per component — used for delta compression.
   * Maps component ID → (entity → last sent SoA values).
   */
  lastSentState: Map<string, Map<Entity, Record<string, unknown>>>

  /** The serializer for runtime components */
  serializer: ReturnType<typeof createRuntimeSerializer>

  /** The timer handle (setInterval or equivalent) */
  timerHandle: unknown
}

/**
 * Execute one runtime binary transport tick.
 *
 * 1. For each runtime-category component:
 *    a. Get dirty entities from the DirtyFlagTracker
 *    b. If full sync interval reached: use ALL entities (not just dirty)
 *    c. Delta-compress against last-sent state
 *    d. Pack into binary buffer via SoA serializer
 *    e. Send via unreliable transport to all connections
 *    f. Update last-sent state
 *    g. Clear dirty flags
 * 2. Increment ticksSinceFullSync (reset on full sync)
 *
 * @param world - The world to transport
 */
declare function executeRuntimeTransportTick(world: World): void
```

#### Pseudocode

```
function executeRuntimeTransportTick(world):
  isFullSync = world.runtimeTransport.ticksSinceFullSync >= world.runtimeTransport.fullSyncInterval

  for componentId of getRegisteredRuntimeComponents(world):
    if isFullSync:
      entities = query(world, [getComponentById(componentId)])
    else:
      entities = world.dirtyFlags.getDirtyEntities(componentId)
      if entities.size === 0:
        continue

    // Serialize dirty entities for this component
    buffer = world.runtimeTransport.serializer(world, [...entities])

    // Send via unreliable transport
    for connection of world.network.connections:
      connection.sendUnreliable(buffer)

    // Update last-sent state (for delta compression on next tick)
    updateLastSentState(world.runtimeTransport.lastSentState, componentId, entities)

    // Clear dirty flags
    world.dirtyFlags.clearDirty(componentId)

  if isFullSync:
    world.runtimeTransport.ticksSinceFullSync = 0
  else:
    world.runtimeTransport.ticksSinceFullSync++
```

### R7: Authored Receive Pipeline

When an authored mutation batch is received from a remote peer, it goes through governance validation before being applied locally.

```typescript
/**
 * Process an incoming authored mutation batch from a remote peer.
 *
 * For each mutation in the batch:
 * 1. Validate against governance constraints (Spec 07: ZCAP, VC, temporal, content)
 * 2. If rejected: discard the mutation, log the violation
 * 3. If accepted:
 *    a. Resolve entity via identity path (Spec 03) → local entity ID
 *    b. If entity doesn't exist locally: create it
 *    c. Apply via setComponent/addRelation with 'network' origin tag
 *    d. Observers fire normally (reactivity, cache maintenance)
 *    e. NOT re-queued for outbound replication (origin = 'network')
 * 4. Append the batch to the local authored event log
 *
 * @param world - The world to apply mutations to
 * @param batch - The incoming mutation batch
 * @param connection - The connection the batch was received from
 * @returns Validation results for each mutation in the batch
 */
declare function processAuthoredBatch(
  world: World,
  batch: AuthoredMutationBatch,
  connection: Connection
): AuthoredBatchResult

/**
 * Result of processing an authored mutation batch.
 */
interface AuthoredBatchResult {
  /** Number of mutations accepted and applied */
  accepted: number

  /** Number of mutations rejected by governance */
  rejected: number

  /** Details of each rejection */
  violations: Array<{
    /** Index of the rejected mutation in the batch */
    mutationIndex: number
    /** The rejected mutation */
    mutation: AuthoredMutation
    /** Governance validation result (from Spec 07) */
    validation: ValidationResult
  }>
}
```

#### Pseudocode

```
function processAuthoredBatch(world, batch, connection):
  result = { accepted: 0, rejected: 0, violations: [] }

  for (i, mutation) of batch.mutations.entries():
    // 1. Verify signature (Spec 06)
    if mutation.signature && !verifySignature(mutation):
      result.rejected++
      result.violations.push({ mutationIndex: i, mutation, validation: { allowed: false, violations: [{ reason: 'Invalid signature' }] } })
      continue

    // 2. Validate against governance (Spec 07)
    validation = validateEvent(world, mutation)
    if !validation.allowed:
      result.rejected++
      result.violations.push({ mutationIndex: i, mutation, validation })
      continue

    // 3. Apply with 'network' origin
    withOrigin('network', () => {
      entity = resolveOrCreateEntity(world, mutation.entityPath)

      switch mutation.type:
        case 'setComponent':
          component = getComponentById(mutation.predicate!)
          setComponent(world, entity, component, mutation.data)

        case 'removeComponent':
          component = getComponentById(mutation.predicate!)
          removeComponent(world, entity, component)

        case 'addRelation':
          relation = getRelationByName(mutation.predicate!)
          target = resolveOrCreateEntity(world, mutation.relationTargetPath!)
          addRelation(world, entity, relation, target)

        case 'removeRelation':
          relation = getRelationByName(mutation.predicate!)
          target = resolveEntityPath(world, mutation.relationTargetPath!)
          if target !== undefined:
            removeRelation(world, entity, relation, target)

        case 'createEntity':
          // Entity was already resolved/created above
          break

        case 'removeEntity':
          removeEntity(world, entity)
    })

    result.accepted++

  // 4. Append to local event log
  world.authoredEventLog.append(batch)

  return result

function resolveOrCreateEntity(world, path):
  entity = resolveEntityPath(world, path)
  if entity !== undefined:
    return entity

  // Create the entity with identity from the path
  entity = createEntity(world)
  if path.length > 0:
    uid = path[path.length - 1]
    setComponent(world, entity, UIDComponent, { value: uid })
    if path.length > 1:
      parentPath = path.slice(0, -1)
      parent = resolveOrCreateEntity(world, parentPath)
      addRelation(world, entity, BelongsTo, parent)

  return entity
```

### R8: Runtime Receive Pipeline

Incoming runtime binary data goes through a lightweight authority check and is written directly to SoA stores — bypassing observers and governance for maximum performance.

```typescript
/**
 * Process incoming runtime binary data from a remote peer.
 *
 * 1. Authority check: is the sending peer authoritative for the entities in this packet?
 *    - If not: discard silently (fast path, no governance overhead)
 * 2. Deserialize binary buffer via bitECS SoA deserializer
 * 3. Entity ID remapping (remote entity IDs → local entity IDs via EntityIdMap)
 * 4. Write directly into SoA stores (bypass setComponent, bypass observers)
 * 5. Queue for interpolation if configured
 *
 * This is the hot path — no governance, no event log, no reactivity overhead.
 *
 * @param world - The world to apply data to
 * @param buffer - The binary data buffer
 * @param connection - The connection the data was received from
 */
declare function processRuntimeData(world: World, buffer: ArrayBuffer, connection: Connection): void
```

#### Pseudocode

```
function processRuntimeData(world, buffer, connection):
  // 1. Determine sending peer
  senderPeer = connection.peer

  // 2. Deserialize with ID remapping
  entityIdMap = world.entityIdMaps.get(connection)
  if !entityIdMap:
    return  // no ID map — can't remap, discard

  // 3. Authority check per entity
  // The deserializer provides entity IDs — check each
  deserializer = world.runtimeTransport.deserializer

  // Use a validating deserializer wrapper that checks authority:
  deserializeWithAuthorityCheck(world, buffer, entityIdMap, senderPeer, (localEntity, componentId) => {
    // Check: is senderPeer authoritative for this entity?
    authorityPeer = getAuthorityPeer(world, localEntity)
    return authorityPeer === senderPeer
  })

  // 4. Direct SoA writes happen inside the deserializer
  // No observers fire, no governance validation
  // The data is now in the local SoA stores

  // 5. Queue for interpolation if configured
  if world.transportConfig.interpolate:
    queueInterpolation(world, affectedEntities)
```

### R9: Transport Configuration

```typescript
/**
 * Per-component transport tuning for runtime-category components.
 */
interface RuntimeTransportConfig {
  /**
   * Component ID (must match a registered ComponentDefinition
   * with mutationCategory: 'runtime').
   */
  component: string

  /**
   * Binary transport tick rate in Hz.
   * @default 60
   */
  rate?: number

  /**
   * Interval (in ticks) between full state syncs for convergence.
   * Full syncs send all entity state, not just deltas.
   * Ensures convergence despite packet loss on unreliable transport.
   * @default 300 (≈5 seconds at 60Hz)
   */
  fullSyncInterval?: number

  /**
   * Whether to apply interpolation on the receiving end.
   * When true, incoming runtime data is buffered and interpolated
   * rather than applied immediately.
   * @default true
   */
  interpolate?: boolean
}

/**
 * Full transport configuration for a world/session.
 */
interface TransportConfiguration {
  /** Per-component overrides for runtime transport parameters */
  runtimeComponents?: RuntimeTransportConfig[]

  /** Default runtime tick rate in Hz (applies to all runtime components without overrides) */
  defaultRate?: number

  /** Default full-sync interval in ticks */
  defaultFullSyncInterval?: number

  /** Default interpolation setting */
  defaultInterpolate?: boolean
}

/**
 * Apply transport configuration to a world/session.
 *
 * Component definitions declare their mutation category (authored/runtime/local).
 * This configuration tunes the transport parameters for runtime-category components
 * without changing which transport path they use.
 *
 * Authored components don't need rate configuration — they're batched end-of-tick
 * and sent reliably whenever mutations occur.
 *
 * @param world - The world to configure
 * @param config - Transport configuration
 *
 * @example
 * configureTransport(world, {
 *   defaultRate: 60,
 *   defaultFullSyncInterval: 300,
 *   runtimeComponents: [
 *     { component: 'Transform', rate: 30 },         // 30Hz for transforms
 *     { component: 'AnimState', interpolate: false }, // no interpolation for animation state
 *   ],
 * })
 */
declare function configureTransport(world: World, config: TransportConfiguration): void
```

#### Pseudocode

```
function configureTransport(world, config):
  world.transportConfig = {
    defaultRate: config.defaultRate ?? 60,
    defaultFullSyncInterval: config.defaultFullSyncInterval ?? 300,
    defaultInterpolate: config.defaultInterpolate ?? true,
    perComponent: new Map(),
  }

  if config.runtimeComponents:
    for entry of config.runtimeComponents:
      comp = getComponentById(entry.component)
      if comp.mutationCategory !== 'runtime':
        throw Error(`Component '${entry.component}' is not a runtime-category component`)

      world.transportConfig.perComponent.set(entry.component, {
        rate: entry.rate ?? world.transportConfig.defaultRate,
        fullSyncInterval: entry.fullSyncInterval ?? world.transportConfig.defaultFullSyncInterval,
        interpolate: entry.interpolate ?? world.transportConfig.defaultInterpolate,
      })

  // (Re)start the runtime transport timer
  restartRuntimeTransportTimer(world)
```

### R10: Connection Interface

```typescript
/**
 * Transport backend type.
 * - 'webrtc': WebRTC DataChannels (preferred for P2P, supports unreliable)
 * - 'websocket': WebSocket (fallback, reliable-only — runtime data sent reliably)
 */
type TransportBackend = 'webrtc' | 'websocket'

/**
 * A live transport link to a remote peer.
 * Represents a single connection to one peer entity.
 */
interface Connection {
  /** The remote peer entity in the local world */
  peer: Entity

  /** Transport backend in use */
  backend: TransportBackend

  /** Connection state */
  state: ConnectionState

  /** Arbitrary metadata (e.g., signalling info, latency measurements) */
  metadata?: Record<string, unknown>

  /** Entity ID map for this connection (local ↔ remote) */
  entityIdMap: EntityIdMap

  /**
   * Send data via reliable transport (ordered, guaranteed delivery).
   * Used for authored mutation batches.
   */
  sendReliable(data: AuthoredMutationBatch): void

  /**
   * Send data via unreliable transport (unordered, may be lost).
   * Used for runtime binary data. Falls back to reliable if
   * backend doesn't support unreliable (e.g., WebSocket).
   */
  sendUnreliable(data: ArrayBuffer): void

  /**
   * Register a handler for incoming reliable data.
   */
  onReliable(handler: (batch: AuthoredMutationBatch) => void): void

  /**
   * Register a handler for incoming unreliable data.
   */
  onUnreliable(handler: (data: ArrayBuffer) => void): void

  /**
   * Close the connection gracefully.
   */
  close(): void
}

/**
 * Connection lifecycle states.
 */
type ConnectionState = 'connecting' | 'connected' | 'disconnecting' | 'disconnected'
```

### R11: Peer Connection Lifecycle

```typescript
/**
 * Establish a connection to a remote peer.
 *
 * 1. Create or resolve the remote peer entity in the local world
 * 2. Set up the transport backend (WebRTC or WebSocket)
 * 3. Perform the handshake (exchange session metadata, component schemas)
 * 4. Create the EntityIdMap for this connection
 * 5. Register the connection in world.network.connections
 * 6. Wire up incoming data handlers (authored → processAuthoredBatch, runtime → processRuntimeData)
 * 7. If late joining: request and apply snapshot (see R12)
 *
 * @param world - The local world
 * @param options - Connection options
 * @returns The established connection
 */
declare function connectToPeer(world: World, options: ConnectOptions): Promise<Connection>

/**
 * Options for connecting to a remote peer.
 */
interface ConnectOptions {
  /** Remote peer identifier (for signalling) */
  remotePeerId: string

  /** Preferred transport backend */
  backend?: TransportBackend

  /** Signalling server URL or handler */
  signalling: string | SignallingHandler

  /**
   * Whether this is a late join (peer joining an existing session).
   * If true, a snapshot will be requested after connection.
   * @default false
   */
  lateJoin?: boolean
}

/**
 * Handler for signalling messages (offer/answer/ICE for WebRTC).
 */
interface SignallingHandler {
  send(message: unknown): void
  onMessage(handler: (message: unknown) => void): void
}

/**
 * Disconnect from a peer.
 *
 * 1. Send graceful disconnect signal if connected
 * 2. Close the transport
 * 3. Remove from world.network.connections
 * 4. Clean up EntityIdMap
 * 5. Fire peer disconnect handlers (see Spec 06 for authority recovery)
 *
 * @param world - The local world
 * @param connection - The connection to close
 * @param graceful - Whether to send a disconnect signal (default: true)
 */
declare function disconnectPeer(world: World, connection: Connection, graceful?: boolean): void
```

#### Pseudocode

```
function connectToPeer(world, options):
  // 1. Set up transport
  if options.backend === 'webrtc' || !options.backend:
    transport = await setupWebRTCTransport(options.signalling, options.remotePeerId)
  else:
    transport = await setupWebSocketTransport(options.signalling)

  // 2. Create peer entity (if not already present)
  peerEntity = findPeerByPeerId(world, options.remotePeerId)
  if !peerEntity:
    peerEntity = createEntity(world)
    setComponent(world, peerEntity, PeerComponent, { peerId: options.remotePeerId })

  // 3. Create connection
  connection = {
    peer: peerEntity,
    backend: transport.type,
    state: 'connecting',
    entityIdMap: createEntityIdMap(),
    sendReliable: transport.sendReliable,
    sendUnreliable: transport.sendUnreliable,
    onReliable: transport.onReliable,
    onUnreliable: transport.onUnreliable,
    close: transport.close,
  }

  // 4. Wire up handlers
  connection.onReliable((batch) => {
    processAuthoredBatch(world, batch, connection)
  })
  connection.onUnreliable((data) => {
    processRuntimeData(world, data, connection)
  })

  // 5. Perform handshake — exchange schema metadata
  await exchangeSchemas(world, connection)

  connection.state = 'connected'
  world.network.connections.add(connection)

  // 6. Late join — request snapshot
  if options.lateJoin:
    snapshot = await requestSnapshot(connection)
    applySnapshot(world, snapshot, { idMap: connection.entityIdMap.remoteToLocal })

    // Also request authored event log since snapshot
    events = await requestEventLog(connection, snapshot.metadata.simulationTime)
    for batch of events:
      processAuthoredBatch(world, batch, connection)

  return connection

function disconnectPeer(world, connection, graceful = true):
  if graceful && connection.state === 'connected':
    connection.sendReliable({ type: 'disconnect' })

  connection.state = 'disconnecting'
  connection.close()
  connection.state = 'disconnected'

  world.network.connections.delete(connection)

  // Fire disconnect handlers (Spec 06 handles authority recovery)
  emitPeerDisconnect(world, connection.peer)
```

### R12: Late Join Protocol

When a peer joins an existing session, it needs the current world state. This is delivered via snapshot + event log replay.

```typescript
/**
 * Handle a late-join request from a connecting peer.
 * Called on the host/relay peer when a new peer connects.
 *
 * 1. Create a snapshot of the current world state
 * 2. Send the snapshot to the joining peer
 * 3. Send all authored event log entries since the snapshot
 * 4. Begin normal replication
 *
 * @param world - The local world
 * @param connection - The connection to the joining peer
 */
declare function handleLateJoin(world: World, connection: Connection): void

/**
 * Request a snapshot from a connected peer (for late join).
 *
 * @param connection - The connection to request from
 * @returns The snapshot from the remote peer
 */
declare function requestSnapshot(connection: Connection): Promise<Snapshot>

/**
 * Request authored event log entries since a given time.
 *
 * @param connection - The connection to request from
 * @param sinceTime - Simulation time to start from
 * @returns Authored mutation batches since the given time
 */
declare function requestEventLog(connection: Connection, sinceTime: number): Promise<AuthoredMutationBatch[]>
```

#### Pseudocode

```
function handleLateJoin(world, connection):
  // 1. Create snapshot
  snapshot = createSnapshot(world)

  // 2. Send snapshot
  connection.sendReliable({ type: 'snapshot', snapshot })

  // 3. Send event log since snapshot time
  events = world.authoredEventLog.getSince(snapshot.metadata.simulationTime)
  if events.length > 0:
    connection.sendReliable({ type: 'eventLog', events })

  // 4. Build initial entity ID map from snapshot
  // The joining peer builds its own ID map when applying the snapshot
  // The host builds its side from the snapshot metadata
```

### R13: World Network State Extensions

The World interface is extended with mutation pipeline state:

```typescript
/**
 * Extensions to the World interface for the mutation pipeline.
 */
interface World {
  // ... existing fields from Spec 01, Spec 04 ...

  /** Per-world buffer for authored mutations awaiting end-of-tick batch */
  authoredBuffer: AuthoredMutationBuffer

  /** Append-only history of all authored mutations */
  authoredEventLog: AuthoredEventLog

  /** Dirty flag tracker for runtime component mutations */
  dirtyFlags: DirtyFlagTracker

  /** Runtime binary transport state */
  runtimeTransport: RuntimeTransportState

  /** Transport configuration */
  transportConfig: TransportConfiguration

  /** Per-connection entity ID maps */
  entityIdMaps: Map<Connection, EntityIdMap>

  /** Local user entity (set when joining a networked session, see Spec 06) */
  localUser?: { entity: Entity; did: string; privateKey: Uint8Array }

  /** Local peer entity (set when joining a networked session, see Spec 06) */
  localPeer?: Entity
}
```

---

## Test Specifications

### Origin Tag Tests

```typescript
import { describe, it, expect, vi } from 'vitest'
import { withOrigin, getCurrentOrigin } from '../src/mutation-pipeline'
import type { MutationOrigin } from '../src/mutation-pipeline'

describe('Mutation Origin Tags', () => {
  it('should default to local origin', () => {
    expect(getCurrentOrigin()).toBe('local')
  })

  it('should set origin within withOrigin callback', () => {
    withOrigin('network', () => {
      expect(getCurrentOrigin()).toBe('network')
    })
  })

  it('should restore previous origin after withOrigin completes', () => {
    expect(getCurrentOrigin()).toBe('local')

    withOrigin('network', () => {
      expect(getCurrentOrigin()).toBe('network')
    })

    expect(getCurrentOrigin()).toBe('local')
  })

  it('should support nested withOrigin calls', () => {
    withOrigin('network', () => {
      expect(getCurrentOrigin()).toBe('network')

      withOrigin('local', () => {
        expect(getCurrentOrigin()).toBe('local')
      })

      expect(getCurrentOrigin()).toBe('network')
    })

    expect(getCurrentOrigin()).toBe('local')
  })

  it('should restore origin even if callback throws', () => {
    expect(() => {
      withOrigin('network', () => {
        throw new Error('test error')
      })
    }).toThrow('test error')

    expect(getCurrentOrigin()).toBe('local')
  })
})
```

### Authored Mutation Buffer Tests

```typescript
import { createAuthoredMutationBuffer } from '../src/mutation-pipeline'
import type { AuthoredMutation, AuthoredMutationBuffer } from '../src/mutation-pipeline'

describe('AuthoredMutationBuffer', () => {
  it('should start with no pending mutations', () => {
    const buffer = createAuthoredMutationBuffer()

    expect(buffer.pending).toHaveLength(0)
  })

  it('should queue mutations', () => {
    const buffer = createAuthoredMutationBuffer()

    buffer.queue({
      type: 'setComponent',
      timestamp: 1.0,
      entityPath: ['Scene', 'Player1'],
      predicate: 'Health',
      data: { current: 50 }
    })

    expect(buffer.pending).toHaveLength(1)
    expect(buffer.pending[0].type).toBe('setComponent')
  })

  it('should flush into a batch and clear pending', () => {
    const buffer = createAuthoredMutationBuffer()

    buffer.queue({
      type: 'setComponent',
      timestamp: 1.0,
      entityPath: ['Scene', 'Entity1'],
      predicate: 'Health',
      data: { current: 75 }
    })

    buffer.queue({
      type: 'removeComponent',
      timestamp: 1.0,
      entityPath: ['Scene', 'Entity2'],
      predicate: 'Poison'
    })

    const batch = buffer.flush()

    expect(batch).not.toBeNull()
    expect(batch!.mutations).toHaveLength(2)
    expect(batch!.mutations[0].type).toBe('setComponent')
    expect(batch!.mutations[1].type).toBe('removeComponent')
    expect(buffer.pending).toHaveLength(0)
  })

  it('should return null when flushing with no pending mutations', () => {
    const buffer = createAuthoredMutationBuffer()

    const batch = buffer.flush()
    expect(batch).toBeNull()
  })

  it('should increment sequence numbers across flushes', () => {
    const buffer = createAuthoredMutationBuffer()

    buffer.queue({ type: 'setComponent', timestamp: 1.0, entityPath: ['E1'], predicate: 'A', data: {} })
    const batch1 = buffer.flush()

    buffer.queue({ type: 'setComponent', timestamp: 2.0, entityPath: ['E2'], predicate: 'B', data: {} })
    const batch2 = buffer.flush()

    expect(batch2!.sequenceNumber).toBeGreaterThan(batch1!.sequenceNumber)
  })

  it('should preserve mutation order within a batch', () => {
    const buffer = createAuthoredMutationBuffer()

    buffer.queue({ type: 'setComponent', timestamp: 1.0, entityPath: ['E1'], predicate: 'First', data: {} })
    buffer.queue({ type: 'setComponent', timestamp: 1.0, entityPath: ['E1'], predicate: 'Second', data: {} })
    buffer.queue({ type: 'removeComponent', timestamp: 1.0, entityPath: ['E1'], predicate: 'Third' })

    const batch = buffer.flush()

    expect(batch!.mutations[0].predicate).toBe('First')
    expect(batch!.mutations[1].predicate).toBe('Second')
    expect(batch!.mutations[2].predicate).toBe('Third')
  })
})
```

### Authored Event Log Tests

```typescript
import { createAuthoredEventLog } from '../src/mutation-pipeline'

describe('AuthoredEventLog', () => {
  it('should start empty', () => {
    const log = createAuthoredEventLog()

    expect(log.batches).toHaveLength(0)
    expect(log.mutationCount).toBe(0)
  })

  it('should append batches', () => {
    const log = createAuthoredEventLog()

    log.append({
      mutations: [
        { type: 'setComponent', timestamp: 1.0, entityPath: ['E1'], predicate: 'Health', data: { current: 50 } }
      ],
      senderPeerId: 'peer1',
      sequenceNumber: 1,
      timestamp: 1.0
    })

    expect(log.batches).toHaveLength(1)
    expect(log.mutationCount).toBe(1)
  })

  it('should retrieve mutations since a given time', () => {
    const log = createAuthoredEventLog()

    log.append({
      mutations: [
        { type: 'setComponent', timestamp: 1.0, entityPath: ['E1'], predicate: 'A', data: {} },
        { type: 'setComponent', timestamp: 2.0, entityPath: ['E1'], predicate: 'B', data: {} }
      ],
      senderPeerId: 'peer1',
      sequenceNumber: 1,
      timestamp: 1.0
    })

    log.append({
      mutations: [{ type: 'setComponent', timestamp: 3.0, entityPath: ['E1'], predicate: 'C', data: {} }],
      senderPeerId: 'peer1',
      sequenceNumber: 2,
      timestamp: 3.0
    })

    const since = log.getSince(1.5)

    expect(since).toHaveLength(2) // B (t=2.0) and C (t=3.0)
    expect(since[0].predicate).toBe('B')
    expect(since[1].predicate).toBe('C')
  })

  it('should clear the log', () => {
    const log = createAuthoredEventLog()

    log.append({
      mutations: [{ type: 'setComponent', timestamp: 1.0, entityPath: ['E1'], predicate: 'A', data: {} }],
      senderPeerId: 'peer1',
      sequenceNumber: 1,
      timestamp: 1.0
    })

    log.clear()

    expect(log.batches).toHaveLength(0)
    expect(log.mutationCount).toBe(0)
  })
})
```

### Dirty Flag Tests

```typescript
import { createDirtyFlagTracker } from '../src/mutation-pipeline'

describe('DirtyFlagTracker', () => {
  it('should start with no dirty entities', () => {
    const tracker = createDirtyFlagTracker()

    expect(tracker.getDirtyEntities('Transform').size).toBe(0)
  })

  it('should track dirty entities per component', () => {
    const tracker = createDirtyFlagTracker()

    tracker.markDirty(1, 'Transform')
    tracker.markDirty(2, 'Transform')
    tracker.markDirty(1, 'Velocity')

    expect(tracker.getDirtyEntities('Transform').size).toBe(2)
    expect(tracker.getDirtyEntities('Transform').has(1)).toBe(true)
    expect(tracker.getDirtyEntities('Transform').has(2)).toBe(true)
    expect(tracker.getDirtyEntities('Velocity').size).toBe(1)
    expect(tracker.getDirtyEntities('Velocity').has(1)).toBe(true)
  })

  it('should clear dirty flags per component', () => {
    const tracker = createDirtyFlagTracker()

    tracker.markDirty(1, 'Transform')
    tracker.markDirty(2, 'Velocity')

    tracker.clearDirty('Transform')

    expect(tracker.getDirtyEntities('Transform').size).toBe(0)
    expect(tracker.getDirtyEntities('Velocity').size).toBe(1)
  })

  it('should clear all dirty flags', () => {
    const tracker = createDirtyFlagTracker()

    tracker.markDirty(1, 'Transform')
    tracker.markDirty(2, 'Velocity')

    tracker.clearAll()

    expect(tracker.getDirtyEntities('Transform').size).toBe(0)
    expect(tracker.getDirtyEntities('Velocity').size).toBe(0)
  })

  it('should not duplicate entities when marked dirty multiple times', () => {
    const tracker = createDirtyFlagTracker()

    tracker.markDirty(1, 'Transform')
    tracker.markDirty(1, 'Transform')
    tracker.markDirty(1, 'Transform')

    expect(tracker.getDirtyEntities('Transform').size).toBe(1)
  })
})
```

### Origin-Aware Mutation Tests

```typescript
import { createWorld, destroyWorld } from '../src/world'
import { createEntity } from '../src/entity'
import { defineComponent, setComponent, Schema } from '../src/component'
import { withOrigin } from '../src/mutation-pipeline'

describe('Origin-Aware Mutations', () => {
  const Health = defineComponent({
    id: 'HealthOrigin',
    label: 'Health',
    schema: Schema.Object({
      current: Schema.Number({ default: 100 }),
      max: Schema.Number({ default: 100 })
    })
  })

  it('should queue authored mutations for local-origin operations', () => {
    const world = createWorld()
    const entity = createEntity(world)
    setComponent(world, entity, UIDComponent, { value: 'E1' })

    setComponent(world, entity, Health, { current: 50 })

    // Should have queued a mutation
    expect(world.authoredBuffer.pending.length).toBeGreaterThan(0)
    expect(world.authoredBuffer.pending[0].predicate).toBe('HealthOrigin')

    destroyWorld(world)
  })

  it('should NOT queue authored mutations for network-origin operations', () => {
    const world = createWorld()
    const entity = createEntity(world)
    setComponent(world, entity, UIDComponent, { value: 'E2' })

    withOrigin('network', () => {
      setComponent(world, entity, Health, { current: 50 })
    })

    // Should NOT have queued any mutation
    const healthMutations = world.authoredBuffer.pending.filter((m) => m.predicate === 'HealthOrigin')
    expect(healthMutations).toHaveLength(0)

    destroyWorld(world)
  })

  it('should set dirty flags for local-origin runtime mutations', () => {
    const Transform = defineComponent({
      id: 'TransformOriginTest',
      label: 'Transform',
      mutationCategory: 'runtime',
      schema: Schema.Object({
        position: Schema.Vec3()
      })
    })

    const world = createWorld()
    const entity = createEntity(world)

    setComponent(world, entity, Transform, { position: [1, 2, 3] })

    expect(world.dirtyFlags.getDirtyEntities('TransformOriginTest').has(entity)).toBe(true)

    destroyWorld(world)
  })

  it('should NOT set dirty flags for network-origin runtime mutations', () => {
    const Transform = defineComponent({
      id: 'TransformOriginTest2',
      label: 'Transform',
      mutationCategory: 'runtime',
      schema: Schema.Object({
        position: Schema.Vec3()
      })
    })

    const world = createWorld()
    const entity = createEntity(world)

    withOrigin('network', () => {
      setComponent(world, entity, Transform, { position: [1, 2, 3] })
    })

    expect(world.dirtyFlags.getDirtyEntities('TransformOriginTest2').has(entity)).toBe(false)

    destroyWorld(world)
  })
})
```

### Transport Configuration Tests

```typescript
import { configureTransport } from '../src/transport'

describe('Transport Configuration', () => {
  it('should apply default transport config', () => {
    const world = createWorld()

    configureTransport(world, {})

    expect(world.transportConfig.defaultRate).toBe(60)
    expect(world.transportConfig.defaultFullSyncInterval).toBe(300)

    destroyWorld(world)
  })

  it('should apply custom default rates', () => {
    const world = createWorld()

    configureTransport(world, {
      defaultRate: 30,
      defaultFullSyncInterval: 150
    })

    expect(world.transportConfig.defaultRate).toBe(30)
    expect(world.transportConfig.defaultFullSyncInterval).toBe(150)

    destroyWorld(world)
  })

  it('should apply per-component overrides', () => {
    const Transform = defineComponent({
      id: 'TransformTransport',
      label: 'Transform',
      mutationCategory: 'runtime',
      schema: Schema.Object({ position: Schema.Vec3() })
    })

    const world = createWorld()

    configureTransport(world, {
      runtimeComponents: [{ component: 'TransformTransport', rate: 30, interpolate: false }]
    })

    const override = world.transportConfig.perComponent.get('TransformTransport')
    expect(override).toBeDefined()
    expect(override!.rate).toBe(30)
    expect(override!.interpolate).toBe(false)

    destroyWorld(world)
  })

  it('should reject overrides for non-runtime components', () => {
    const Health = defineComponent({
      id: 'HealthTransport',
      label: 'Health',
      schema: Schema.Object({ current: Schema.Number({ default: 100 }) })
    })

    const world = createWorld()

    expect(() =>
      configureTransport(world, {
        runtimeComponents: [{ component: 'HealthTransport', rate: 30 }]
      })
    ).toThrow()

    destroyWorld(world)
  })
})
```

### End-of-Tick Integration Tests

```typescript
describe('End-of-Tick Batching', () => {
  it('should flush authored mutations after executeFrame', () => {
    const world = createWorld()
    const entity = createEntity(world)
    setComponent(world, entity, UIDComponent, { value: 'BatchTest' })

    const Health = defineComponent({
      id: 'HealthBatch',
      label: 'Health',
      schema: Schema.Object({
        current: Schema.Number({ default: 100 })
      })
    })

    // Set up a system that modifies Health
    defineSystem(world, {
      name: 'DamageSystem',
      phase: 'Simulation',
      execute: (w) => {
        setComponent(w, entity, Health, { current: 75 })
      }
    })

    // Before frame: no mutations pending
    expect(world.authoredBuffer.pending).toHaveLength(0)

    // Execute a frame
    executeFrame(world, 1.0)
    executeFrame(world, 1.0 + world.fixedTimeStep)

    // After frame: buffer should be flushed (pending is empty after flush)
    // The event log should have recorded the batch
    expect(world.authoredEventLog.mutationCount).toBeGreaterThan(0)

    destroyWorld(world)
  })

  it('should batch multiple mutations from the same frame into one batch', () => {
    const world = createWorld()
    const e1 = createEntity(world)
    const e2 = createEntity(world)
    setComponent(world, e1, UIDComponent, { value: 'E1' })
    setComponent(world, e2, UIDComponent, { value: 'E2' })

    const Tag = defineComponent({
      id: 'TagBatch',
      label: 'Tag',
      schema: Schema.Object({ label: Schema.String() })
    })

    defineSystem(world, {
      name: 'TaggerSystem',
      phase: 'Simulation',
      execute: (w) => {
        setComponent(w, e1, Tag, { label: 'first' })
        setComponent(w, e2, Tag, { label: 'second' })
      }
    })

    executeFrame(world, 1.0)
    executeFrame(world, 1.0 + world.fixedTimeStep)

    // Should be one batch with two mutations
    expect(world.authoredEventLog.batches).toHaveLength(1)
    expect(world.authoredEventLog.batches[0].mutations.length).toBeGreaterThanOrEqual(2)

    destroyWorld(world)
  })
})
```

---

## Edge Cases & Constraints

1. **Origin tag is context-scoped, not per-mutation.** All ECS operations within a `withOrigin` callback share the same origin. Nesting is supported via a stack.

2. **Local-category components are never queued.** `setComponent` on a local-category component does NOT queue authored mutations or set dirty flags, regardless of origin.

3. **Authored mutations must include entity identity paths.** Entity IDs are never sent over the network (Spec 01, R8). The `entityPath` field (from Spec 03 identity resolution) is how remote peers resolve the target entity.

4. **Batch ordering is significant.** Mutations within a batch MUST be applied in the order they were queued. Re-ordering mutations can break state consistency (e.g., create-then-set vs set-then-create).

5. **Full state syncs are authoritative.** When a full state sync is received for a runtime component, it replaces the local state entirely — partial/stale data from missed delta packets is overwritten.

6. **WebSocket fallback for runtime data.** When the transport backend is WebSocket (which doesn't support unreliable channels), runtime data is sent reliably. This increases latency and bandwidth but maintains correctness.

7. **Event log compaction is destructive.** After `compact()`, mutations before the compaction snapshot are permanently lost. The snapshot becomes the new baseline. Compact only at safe boundaries (session end, explicit save points).

8. **Late join is not atomic.** Between receiving the snapshot and receiving buffered event log entries, the joining peer may miss mutations that occurred during the transfer. The snapshot + event replay approach handles this by replaying events that overlap with the snapshot (idempotent application).

9. **Dirty flags are per-entity-per-component, not per-field.** If any SoA field of a runtime component is written, the entire component is re-serialised for that entity. Per-field dirty tracking could be added as an optimisation but is not required initially.

10. **Runtime data bypasses observers.** Incoming runtime binary data writes directly to SoA stores WITHOUT firing `onSet` observers. This is intentional for performance — the hot path must avoid reactivity overhead. If reactive behaviour is needed for runtime data, systems should poll SoA stores.

11. **Signature verification is optional on trusted transports.** In client-server topologies where the server is trusted, signature verification may be skipped for performance. The `authorDID` and `signature` fields are populated but verification is controlled by configuration.

12. **Entity creation from network.** When an authored mutation references an entity path that doesn't exist locally, the entity is created automatically (with its identity set from the path). This is how entity creation propagates across the network.

---

## Dependencies

- **Spec 01 (`01-world-entity.md`)**: World, Entity, time state
- **Spec 02 (`02-component-definitions.md`)**: `defineComponent`, `setComponent`, `removeComponent`, `hasComponent`, `getComponent`, `ComponentDefinition`, `MutationCategory`, `Schema`, observers
- **Spec 03 (`03-relations-identity.md`)**: `defineRelation`, `addRelation`, `removeRelation`, `BelongsTo`, `UIDComponent`, `getEntityPath`, `resolveEntityPath`, identity resolution
- **Spec 04 (`04-systems-prefabs-serialization.md`)**: `executeFrame`, `createRuntimeSerializer`, `createRuntimeDeserializer`, `createSnapshot`, `applySnapshot`, `EntityIdMap`, `createEntityIdMap`, `serializeComponentToJSON`
- **Spec 06 (`06-users-peers-authority.md`)** (forward reference): `PeerComponent`, user DID identity, authority checks for runtime receive pipeline
- **Spec 07 (`07-governance.md`)** (forward reference): `validateEvent` for authored receive pipeline governance validation
- **bitECS v4**: `createSoASerializer`, `createSoADeserializer`, `query`, observers
