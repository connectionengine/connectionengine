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
 *   4. LIVE     — authored envelopes and bind controls. Each authored envelope
 *                 goes out again, as a mesh flood, to every other connection on
 *                 every network.
 *
 * Wire protocol over `stream`: binary packets from the per-connection
 * `BinaryChannel`, sent point to point.
 *
 * A session belongs to one Network. A peer with both a voice channel and a
 * gameplay channel therefore holds two separate connections, one per network.
 * Whether those connections share one physical transport is a transport-layer
 * concern.
 */

import type { AuthoredEnvelope, Entity, World } from '../../ecs/world'
import type { ComponentDefinition } from '../../ecs/component'
import { getComponent, setComponent } from '../../ecs/component'
import { applyAuthoredEnvelope, flushAuthored } from '../mutation'
import { createEntity } from '../../ecs/entity'
import { getEntityByUID, getEntityPath, setUID } from '../../ecs/entity'
import { addRelation } from '../../ecs/relation'
import { AuthoritativeFor, OwnedBy } from '../authority'
import { PeerComponent, UserComponent } from '../agents'
import type { RuntimeTransportConfig, TransportEndpoint } from '../transport'
import type { Connection, Network } from '../network'
import { ensureDefaultNetwork } from '../network'
import { createBinaryChannel, isBindControl } from './binary-channel'
import { getConnectionChannel, installFanout, rebroadcastAuthored, setConnectionChannel } from './fanout'
import { getNetworkIdTable, type NetworkIdBinding } from './network-id'
import {
  applyReplayChunk,
  applyStateSnapshot,
  endReplay,
  streamEventLog,
  streamStateSnapshot,
  type ReplayChunkMessage,
  type ReplayEndMessage,
  type SnapshotMessage
} from './replay'
import { sweepDisconnectedPeer } from './sweep'

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
            streamEventLog(world, endpoint, payload.knownEventCount, chunkSize)
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
      applyAuthoredEnvelope(world, envelope, network)
      rebroadcastAuthored(world, connection, envelope)
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
