/**
 * Session — the joinNetwork and leaveNetwork orchestration over a
 * TransportEndpoint.
 *
 * Every endpoint carries two channels:
 *   - `events`   — control messages and authored envelopes. Reliable and ordered.
 *   - `stream`   — binary runtime packets, as `ArrayBuffer` values.
 *
 * Wire protocol over `events`:
 *
 *   1. HELLO    — exchange { agentDID, knownEventCount, bindings }
 *   2. REPLAY   — the host streams its event log from the known cursor of the
 *                 joiner.
 *   3. SNAPSHOT — the current state, with all components on every channel. The
 *                 receiver applies it over the replayed history.
 *   4. LIVE     — authored envelopes and bind controls. Whatever an incoming
 *                 envelope leaves accepted goes out again to every other
 *                 connection on this network, which reaches peers that only
 *                 this one can see.
 *
 * Wire protocol over `stream`: binary packets from the per-connection
 * `BinaryChannel`, sent point to point.
 *
 * A session belongs to one Network. A peer with both a voice channel and a
 * gameplay channel therefore holds two separate connections, one per network.
 * Whether those connections share one physical transport is a transport-layer
 * concern.
 */

import type { AuthoredEnvelope, AuthoredEvent, Entity, World } from '../../ecs/world'
import type { ComponentDefinition } from '../../ecs/component'
import { allComponents, getComponent, hasSyncedSoA, setComponent } from '../../ecs/component'
import { applyAuthoredEnvelope, flushAuthored } from '../mutation'
import * as bitecs from 'bitecs'
import { createEntity, removeEntity } from '../../ecs/entity'
import { getEntityByUID, getEntityPath, setUID } from '../../ecs/entity'
import { addRelation } from '../../ecs/relation'
import { AuthoritativeFor, OwnedBy, getAuthority, recoverAuthority } from '../authority'
import { PeerComponent, UserComponent, findUserByDID } from '../agents'
import type { RuntimeTransportConfig, TransportEndpoint } from '../transport'
import type { Connection, Network } from '../network'
import { ensureDefaultNetwork, getNetworks } from '../network'
import { createBinaryChannel, isBindControl, type BinaryChannel } from './binary-channel'
import { getNetworkIdTable, type NetworkIdBinding } from './network-id'
import {
  applyReplayChunk,
  applyStateSnapshot,
  cursorFingerprint,
  endReplay,
  streamEventLog,
  streamStateSnapshot,
  type ReplayChunkMessage,
  type ReplayEndMessage,
  type SnapshotMessage
} from './replay'

// ── Control messages ─────────────────────────────────────────────────────────-

interface HelloMessage {
  type: 'hello'
  agentDID: string
  /** Stable per-engine peer id. */
  peerId: string
  /** Entity paths of the local User and Peer entities of the sender. The
   *  receiver uses them to materialise its local view of the remote peer at the
   *  same UID that the authored events of the sender will use. That prevents
   *  duplicate user and peer entities when a later replay re-creates them. Both
   *  paths stay empty when the sender has established no local identity, as in
   *  a test flow or a solo flow. */
  userPath: string[]
  peerPath: string[]
  knownEventCount: number
  /** Signature of the last event the sender holds. The receiver uses it to
   *  confirm that `knownEventCount` names a shared prefix before it skips
   *  events during replay. */
  cursorFingerprint?: string
  bindings: NetworkIdBinding[]
}

interface LeaveMessage {
  type: 'leave'
  agentDID: string
}

type ControlMessage = HelloMessage | LeaveMessage | ReplayChunkMessage | ReplayEndMessage | SnapshotMessage

const isControl = (payload: unknown): payload is ControlMessage =>
  !!payload && typeof payload === 'object' && typeof (payload as { type?: unknown }).type === 'string'

const isAuthoredEnvelope = (payload: unknown): payload is AuthoredEnvelope =>
  !!payload && typeof payload === 'object' && Array.isArray((payload as { events?: unknown }).events)

// ── joinNetwork / joinWorld ─────────────────────────────────────────────────-

export interface JoinNetworkOptions {
  endpoint: TransportEndpoint
  /** Network to join over this endpoint. It defaults to the 'default' network
   *  of the world, which the engine creates on demand. */
  network?: Network
  /** Replay the remote event log on join. It defaults to true. */
  replayEventLog?: boolean
  /**
   * Send a full state snapshot to the peer on join. It defaults to true. A
   * continuous-channel component needs it to reach a late joiner at all,
   * because such a component is absent from the event log, and the binary
   * channel sends only the dirty entities. Disable it only when the peer
   * bootstraps its state through another path.
   */
  sendStateSnapshot?: boolean
  /** Cursor. Skip every event at or before this index in the remote log. It
   *  defaults to 0. */
  knownEventCount?: number
  /** Hard cap on the number of events in one replay chunk. It defaults to 256. */
  replayChunkSize?: number
  /** Runtime components to attach for binary replication on this connection. */
  runtimeComponents?: readonly ComponentDefinition[]
  /** Per-component transport config. */
  runtimeConfigs?: RuntimeTransportConfig[]
}

export interface JoinResult {
  connection: Connection
  network: Network
  remoteDID: string
  replayedEventCount: number
  /** Number of entities received in the bootstrap snapshot of the peer. */
  snapshotEntityCount: number
}

const wrapEndpoint = (endpoint: TransportEndpoint): Connection => ({
  peer: 0,
  remoteDID: 'did:unknown:pending',
  events: endpoint.events,
  stream: endpoint.stream,
  onClose: (h) => endpoint.onClose(h),
  close: () => endpoint.close()
})

/**
 * Bring the local world up to date with the remote peer over `endpoint`. The
 * connection joins the `network` that the caller names. It defaults to the
 * `'default'` network of the world, which the engine creates on the first call.
 * The promise resolves after the replay phase completes. Live envelopes then
 * flow over the same endpoint, with no further setup.
 *
 * The replay chunks of the peer precede its bootstrap snapshot on the ordered
 * events channel, and the replay-end marker follows both. The receiver has
 * therefore applied the snapshot by the time this promise resolves. With
 * `replayEventLog: false` there is nothing to await, and the snapshot lands
 * some time after the returned promise resolves.
 */
export const joinNetwork = async (world: World, options: JoinNetworkOptions): Promise<JoinResult> => {
  const { endpoint } = options
  const network = options.network ?? ensureDefaultNetwork(world)
  const wantReplay = options.replayEventLog !== false
  const wantSnapshot = options.sendStateSnapshot !== false
  const chunkSize = options.replayChunkSize ?? 256
  const myKnownCount = options.knownEventCount ?? 0

  installFanout(world, network)

  const connection = wrapEndpoint(endpoint)
  if (options.runtimeComponents && options.runtimeComponents.length > 0) {
    const channel = createBinaryChannel(world, connection, {
      components: options.runtimeComponents,
      configs: options.runtimeConfigs
    })
    setConnectionChannel(connection, channel)
  }

  let replayedEventCount = 0
  let snapshotEntityCount = 0
  let resolveReplay!: () => void
  const replayPromise = new Promise<void>((r) => {
    resolveReplay = r
  })

  endpoint.events.onMessage((payload) => {
    if (isControl(payload)) {
      switch (payload.type) {
        case 'hello': {
          connection.remoteDID = payload.agentDID
          connection.peer = ensureRemotePeerEntity(world, payload)
          getChannelOrNull(connection)?.registerBindings(payload.bindings)
          flushAuthored(world)
          // History first, then the present. `replay.ts` explains why the order
          // matters.
          if (wantReplay && payload.knownEventCount < world.eventLog.length) {
            streamEventLog(world, endpoint, payload.knownEventCount, chunkSize, payload.cursorFingerprint)
          }
          if (wantSnapshot) streamStateSnapshot(world, endpoint)
          if (wantReplay) endReplay(world, endpoint)
          break
        }
        case 'snapshot':
          snapshotEntityCount += applyStateSnapshot(world, payload.snapshot, connection.remoteDID, network)
          break
        case 'replay-chunk':
          replayedEventCount += applyReplayChunk(world, connection.remoteDID, payload.events, network)
          break
        case 'replay-end':
          resolveReplay()
          break
        case 'leave':
          sweepDisconnectedPeer(world, connection)
          connection.close()
          break
      }
      return
    }
    if (isBindControl(payload)) {
      getChannelOrNull(connection)?.registerBindings(payload.bindings)
      return
    }
    if (isAuthoredEnvelope(payload)) {
      const envelope = payload
      // Apply first, then relay what the apply accepted. Relaying the raw
      // envelope instead would forward the events this peer rejected and drop
      // the ones it took.
      const accepted = applyAuthoredEnvelope(world, envelope, network)
      rebroadcastAuthored(network, connection, envelope.fromPeer, accepted)
      return
    }
  })

  endpoint.stream.onMessage((buffer) => {
    if (!options.runtimeComponents) return
    getChannelOrNull(connection)?.applyBuffer(buffer)
  })

  endpoint.onClose(() => {
    sweepDisconnectedPeer(world, connection)
    network.connections.delete(connection)
  })

  network.connections.add(connection)

  const localBindings = options.runtimeComponents ? getNetworkIdTable(world).bindings() : []
  endpoint.events.send({
    type: 'hello',
    agentDID: world.localAgent.did,
    peerId: localPeerId(world),
    userPath: world.localUser !== undefined ? getEntityPath(world, world.localUser) : [],
    peerPath: world.localPeer !== undefined ? getEntityPath(world, world.localPeer) : [],
    knownEventCount: myKnownCount,
    cursorFingerprint: myKnownCount > 0 ? cursorFingerprint(world) : undefined,
    bindings: localBindings
  } satisfies HelloMessage)

  if (wantReplay) await replayPromise

  return { connection, network, remoteDID: connection.remoteDID, replayedEventCount, snapshotEntityCount }
}

/** Backward-compatible alias. `joinWorld` calls `joinNetwork` over the default
 *  network. */
export const joinWorld = joinNetwork
export type JoinWorldOptions = JoinNetworkOptions

/**
 * Leave a network. The function sends a graceful-leave signal to the peer,
 * closes the endpoint, and runs the disconnect cleanup locally.
 */
export const leaveWorld = async (world: World, connection: Connection): Promise<void> => {
  try {
    connection.events.send({ type: 'leave', agentDID: world.localAgent.did } satisfies LeaveMessage)
  } catch {
    // The peer may have gone already.
  }
  sweepDisconnectedPeer(world, connection)
  connection.close()
}

const getChannelOrNull = (connection: Connection) => getConnectionChannel(connection) ?? null

/**
 * Resolve the peerId of the local engine. HELLO carries that value, so that the
 * remote side can find a Peer entity that uniquely represents this engine
 * instance, or create one. The function falls back to the agent DID when no
 * local Peer entity exists yet, as in a test flow or a solo flow.
 */
const localPeerId = (world: World): string => {
  if (world.localPeer !== undefined) {
    const value = getComponent(world, world.localPeer, PeerComponent) as { peerId?: string } | undefined
    if (value?.peerId) return value.peerId
  }
  return world.localAgent.did
}

/**
 * Find the local representation of the remote peer, or create it. The function
 * uses the paths that the sender encoded in its HELLO. It walks by path, with
 * the same scheme that `ensureEntityPath` uses for replay. An entity
 * materialised here is therefore the same entity that replay reuses later, so
 * no duplicate user or peer rows appear.
 *
 * The function falls back to the UIDs `user:<did>` and `peer:<peerId>` when the
 * sender has set up no local identity, as in a test flow or a solo flow.
 */
const ensureRemotePeerEntity = (world: World, hello: HelloMessage): Entity => {
  const userPath = hello.userPath.length > 0 ? hello.userPath : [`user:${hello.agentDID}`]
  const peerPath = hello.peerPath.length > 0 ? hello.peerPath : [...userPath, `peer:${hello.peerId}`]
  const user = ensureAgentPath(world, userPath, (cursor) => {
    setComponent(world, cursor, UserComponent, { did: hello.agentDID, displayName: '' }, { origin: 'network' })
    addRelation(world, cursor, OwnedBy, cursor, { origin: 'network' })
  })
  return ensureAgentPath(world, peerPath, (cursor) => {
    setComponent(world, cursor, PeerComponent, { peerId: hello.peerId, latency: 0 }, { origin: 'network' })
    addRelation(world, cursor, OwnedBy, user, { origin: 'network' })
    addRelation(world, cursor, AuthoritativeFor, cursor, { origin: 'network' })
  })
}

/**
 * Walk a UID path, and create every missing node silently. The function runs
 * `decorate` on the leaf when, and only when, it created that leaf. A leaf that
 * already existed already carries its components, from replay or from earlier
 * setup.
 */
const ensureAgentPath = (world: World, path: string[], decorate: (entity: Entity) => void): Entity => {
  let parent: Entity = world.worldRoot
  let cursor: Entity = world.worldRoot
  let freshLeaf = false
  for (let i = 0; i < path.length; i++) {
    const uid = path[i]
    const existing = getEntityByUID(world, parent, uid)
    if (existing !== undefined) {
      cursor = existing
      freshLeaf = false
    } else {
      cursor = createEntity(world)
      if (parent === world.worldRoot) setUID(world, cursor, uid, { origin: 'network' })
      else setUID(world, cursor, uid, { parent, origin: 'network' })
      freshLeaf = i === path.length - 1
    }
    parent = cursor
  }
  if (freshLeaf) decorate(cursor)
  return cursor
}

// ── Outbound publish + relay ─────────────────────────────────────────────────-
//
// A Network needs someone to turn its publish hooks into actual sends. That is
// this: `installFanout` fans an envelope across the connections of one network,
// and `rebroadcastAuthored` relays onward what an inbound envelope left
// accepted.

const channels = new WeakMap<Connection, BinaryChannel>()

export const setConnectionChannel = (connection: Connection, channel: BinaryChannel): void => {
  channels.set(connection, channel)
}

export const getConnectionChannel = (connection: Connection): BinaryChannel | undefined => channels.get(connection)

/**
 * Get the binary channel of a connection, or create it. The lazy build draws
 * from every continuous-channel ComponentDefinition on the engine of the world,
 * sorted by id for a deterministic, peer-agnostic order. The engine registry
 * then guarantees that both sides reach the same list, for as long as both
 * packages have imported the same component modules.
 */
export const ensureChannel = (world: World, connection: Connection): BinaryChannel | undefined => {
  let channel = channels.get(connection)
  if (channel) return channel
  const components = allComponents()
    .filter(hasSyncedSoA)
    .sort((a, b) => (a.$id < b.$id ? -1 : a.$id > b.$id ? 1 : 0))
  if (components.length === 0) return undefined
  channel = createBinaryChannel(world, connection, { components })
  channels.set(connection, channel)
  return channel
}

/**
 * Install the fanout on a network. The function is idempotent. It attaches
 * `publishAuthored` and `publishRuntime`, so that each hook fans across the
 * connections of this network. The runtime binary path uses the `BinaryChannel`
 * of each connection.
 */
export const installFanout = (world: World, network: Network): void => {
  if (network.publishAuthored && network.publishRuntime) return
  if (!network.publishAuthored) {
    network.publishAuthored = (envelope: AuthoredEnvelope) => {
      for (const conn of network.connections) conn.events.send(envelope)
    }
  }
  if (!network.publishRuntime) {
    network.publishRuntime = (dirty: Map<string, Set<Entity>>) => {
      for (const conn of network.connections) {
        const channel = ensureChannel(world, conn)
        if (!channel) continue
        channel.publish(dirty)
      }
    }
  }
}

/**
 * Relay an authored envelope onward, so that a peer reachable only through this
 * one still receives it. `events` must be the list that `applyAuthoredEnvelope`
 * accepted, in arrival order.
 *
 * Pass the accepted list rather than the whole envelope. `appendEventLog` has
 * already recorded those events, so a `hasEventBeenSeen` filter applied here
 * would discard every one of them and forward only what this peer refused.
 * Feeding the accepted list forward means a peer relays what it took, and a
 * duplicate arriving by a second path stops at the receiver's own log check.
 *
 * The relay stays inside `network`. An event that arrives on one network does
 * not cross into another, because a network is a sync scope and its members did
 * not necessarily agree to receive the traffic of any other.
 */
export const rebroadcastAuthored = (
  network: Network,
  source: Connection,
  fromPeer: string,
  events: readonly AuthoredEvent[]
): void => {
  if (events.length === 0) return
  let targets = 0
  for (const conn of network.connections) if (conn !== source) targets++
  if (targets === 0) return
  const out: AuthoredEnvelope = { fromPeer, events: events.slice() }
  for (const conn of network.connections) {
    if (conn === source) continue
    conn.events.send(out)
  }
}

// ── Disconnect cleanup ───────────────────────────────────────────────────────-
//
// Two things follow from a connection closing, and both are consequences of
// the ownership model rather than choices a caller makes.

/**
 * Disconnect cleanup. Authority recovery always runs, because every disconnect
 * can cost an authority. The sweep of user-owned entities runs only when this
 * connection was the last connection of that user on the world.
 */
export const sweepDisconnectedPeer = (world: World, connection: Connection): void => {
  recoverAuthorityForLeavingPeer(world, connection)

  const did = connection.remoteDID
  if (!did || did.startsWith('did:unknown')) return
  const userEntity = findUserByDID(world, did)
  if (userEntity === undefined) return
  for (const network of getNetworks(world).values()) {
    for (const other of network.connections) {
      if (other === connection) continue
      if (other.remoteDID && findUserByDID(world, other.remoteDID) === userEntity) return
    }
  }
  // This was the last connection of the user, so remove every entity that the
  // user owns. Snapshot the set first, because removeEntity mutates the
  // AuthoritativeFor query.
  const owned = bitecs.query(world.engine.bitECS, [OwnedBy.$relation(userEntity)]) as Entity[]
  for (const e of [...owned]) {
    if (e === userEntity) continue
    removeEntity(world, e)
  }
}

/**
 * Walk every entity in the world whose authority targets `connection.peer`, and
 * reassign each one through `recoverAuthority`. The function does nothing when
 * the connection carries no peer entity, which happens when its HELLO never
 * arrived.
 */
const recoverAuthorityForLeavingPeer = (world: World, connection: Connection): void => {
  const leavingPeer = connection.peer
  if (!leavingPeer) return
  // Walk every entity in the engine that targets the leaving peer through
  // AuthoritativeFor. The walk reads the targets index of the relation directly.
  const owingEntities: Entity[] = []
  for (const candidate of bitecs.query(world.engine.bitECS, [AuthoritativeFor.$relation(leavingPeer)]) as Entity[]) {
    if (getAuthority(world, candidate) === leavingPeer) owingEntities.push(candidate)
  }
  for (const e of owingEntities) recoverAuthority(world, e, leavingPeer)
}
