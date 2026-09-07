/**
 * Session — joinNetwork / leaveNetwork orchestration over a TransportEndpoint.
 *
 * Two channels on every endpoint:
 *   - `events`   — control messages + authored envelopes (reliable, ordered)
 *   - `stream`   — binary runtime packets (`ArrayBuffer`)
 *
 * Wire protocol over `events`:
 *
 *   1. HELLO    — exchange { agentDID, knownEventCount, bindings }
 *   2. SNAPSHOT — full state baseline (all components, every channel). This is
 *                 what bootstraps continuous-channel components, which have no
 *                 event-log representation and are only ever delta-shipped
 *                 while dirty.
 *   3. REPLAY   — host streams its event log from joiner's known cursor.
 *   4. LIVE     — authored envelopes + bind controls. Authored is rebroadcast
 *                 (mesh flood) to every other connection on every network.
 *
 * Wire protocol over `stream`: binary packets from the per-connection
 * `BinaryChannel`, point-to-point.
 *
 * The session is per-Network — a peer with both voice and gameplay channels
 * has two distinct connections, one per network. Whether they share an
 * underlying physical transport is a transport-layer concern.
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
  /** Entity paths of the sender's local User and Peer entities. Receiver uses
   *  these to materialise its local view of the remote peer at the same UID
   *  the sender's own authored events will use — preventing duplicate user/
   *  peer entities when replay later re-creates them. Empty when the sender
   *  hasn't established local identity (test / solo flows). */
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
  /** Network to join over this endpoint. Defaults to the world's 'default' network (auto-created). */
  network?: Network
  /** Replay remote event log on join. Default true. */
  replayEventLog?: boolean
  /**
   * Send a full state snapshot to the peer on join. Default true. Required
   * for continuous-channel components to reach a late joiner at all — they
   * are absent from the event log and the binary channel only ships dirty
   * entities. Disable only when the peer bootstraps state out-of-band.
   */
  sendStateSnapshot?: boolean
  /** Cursor: skip events at or before this index in the remote log. Default 0. */
  knownEventCount?: number
  /** Hard cap on events streamed per chunk during replay. Default 256. */
  replayChunkSize?: number
  /** Runtime components to wire for binary replication on this connection. */
  runtimeComponents?: readonly ComponentDefinition[]
  /** Per-component transport config. */
  runtimeConfigs?: RuntimeTransportConfig[]
}

export interface JoinResult {
  connection: Connection
  network: Network
  remoteDID: string
  replayedEventCount: number
  /** Entities received in the peer's bootstrap snapshot. */
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
 * connection joins the specified `network` (default: the world's `'default'`
 * network, auto-created on first call). Resolves after the replay phase
 * completes; live envelopes flow over the same endpoint with no further
 * setup.
 *
 * The peer's bootstrap snapshot precedes its replay chunks on the ordered
 * events channel, so by the time this resolves the snapshot has been applied.
 * With `replayEventLog: false` there is nothing to await — the snapshot then
 * lands some time after the returned promise resolves.
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
          // Snapshot before replay: it establishes the full entity graph
          // (including continuous-only entities that no authored event would
          // ever create) so subsequent binary bindings resolve, and replay
          // then layers authored history on top of the same baseline.
          if (wantSnapshot) streamStateSnapshot(world, endpoint)
          if (wantReplay && payload.knownEventCount < world.eventLog.length) {
            streamEventLog(world, endpoint, payload.knownEventCount, chunkSize)
          } else if (wantReplay) {
            endpoint.events.send({
              type: 'replay-end',
              totalEvents: world.eventLog.length
            } satisfies ReplayEndMessage)
          }
          break
        }
        case 'snapshot':
          snapshotEntityCount += applyStateSnapshot(world, payload.snapshot)
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

/** Back-compat alias — `joinWorld` is `joinNetwork` over the default network. */
export const joinWorld = joinNetwork
export type JoinWorldOptions = JoinNetworkOptions

/**
 * Leave a network: send a graceful-leave signal to the peer, close the
 * endpoint, run disconnect cleanup locally.
 */
export const leaveWorld = async (world: World, connection: Connection): Promise<void> => {
  try {
    connection.events.send({ type: 'leave', agentDID: world.localAgent.did } satisfies LeaveMessage)
  } catch {
    // peer may already be gone
  }
  sweepDisconnectedPeer(world, connection)
  connection.close()
}

const getChannelOrNull = (connection: Connection) => getConnectionChannel(connection) ?? null

/**
 * Resolve the local engine's peerId — the value sent in HELLO so the remote
 * side can locate (or create) a Peer entity that uniquely represents this
 * engine instance. Falls back to the agent DID when no local Peer entity is
 * set up yet (test / solo flows).
 */
const localPeerId = (world: World): string => {
  if (world.localPeer !== undefined) {
    const value = getComponent(world, world.localPeer, PeerComponent) as { peerId?: string } | undefined
    if (value?.peerId) return value.peerId
  }
  return world.localAgent.did
}

/**
 * Find (or create) the local representation of the remote peer using the
 * paths the sender encoded in their HELLO. Walking by path (the same scheme
 * `ensureEntityPath` uses for replay) means an entity materialised here is
 * the same entity replay will reuse — no duplicate user/peer rows.
 *
 * Falls back to `user:<did>` / `peer:<peerId>` UIDs when the sender hasn't
 * set up local identity (test / solo flows).
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
 * Walk a UID path, creating any missing nodes silently. Runs `decorate` on
 * the leaf when (and only when) it was freshly created — pre-existing leaves
 * already carry their components from replay or earlier setup.
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
