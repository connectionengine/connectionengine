/**
 * Session — joinNetwork / leaveNetwork orchestration over a TransportEndpoint.
 *
 * Two channels on every endpoint:
 *   - `events`   — control messages + authored envelopes (reliable, ordered)
 *   - `stream`   — binary runtime packets (`ArrayBuffer`)
 *
 * Wire protocol over `events`:
 *
 *   1. HELLO   — exchange { agentDID, knownEventCount, bindings }
 *   2. REPLAY  — host streams its event log from joiner's known cursor.
 *   3. LIVE    — authored envelopes + bind controls. Authored is rebroadcast
 *                (mesh flood) to every other connection on every network.
 *
 * Wire protocol over `stream`: binary packets from the per-connection
 * `BinaryChannel`, point-to-point.
 *
 * The session is per-Network — a peer with both voice and gameplay channels
 * has two distinct connections, one per network. The underlying physical
 * transport may be shared (via `engine.peers.acquire`).
 */

import type { AuthoredEnvelope, Connection, World } from '../../ecs/world'
import type { ComponentDefinition } from '../../ecs/component'
import { applyAuthoredEnvelope, flushAuthored } from '../../engine/mutation'
import type { RuntimeTransportConfig, TransportEndpoint } from '../transport'
import type { Network } from '../network'
import { ensureDefaultNetwork } from '../network'
import { createBinaryChannel, isBindControl } from './binary-channel'
import { getConnectionChannel, installFanout, rebroadcastAuthored, setConnectionChannel } from './fanout'
import { getNetworkIdTable, type NetworkIdBinding } from './network-id'
import { applyReplayChunk, streamEventLog, type ReplayChunkMessage, type ReplayEndMessage } from './replay'
import { sweepDisconnectedPeer } from './sweep'

// ── Control messages ─────────────────────────────────────────────────────────-

interface HelloMessage {
  type: 'hello'
  agentDID: string
  knownEventCount: number
  bindings: NetworkIdBinding[]
}

interface LeaveMessage {
  type: 'leave'
  agentDID: string
}

type ControlMessage = HelloMessage | LeaveMessage | ReplayChunkMessage | ReplayEndMessage

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
 */
export const joinNetwork = async (world: World, options: JoinNetworkOptions): Promise<JoinResult> => {
  const { endpoint } = options
  const network = options.network ?? ensureDefaultNetwork(world)
  const wantReplay = options.replayEventLog !== false
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
  let resolveReplay!: () => void
  const replayPromise = new Promise<void>((r) => {
    resolveReplay = r
  })

  endpoint.events.onMessage((payload) => {
    if (isControl(payload)) {
      switch (payload.type) {
        case 'hello': {
          connection.remoteDID = payload.agentDID
          getChannelOrNull(connection)?.registerBindings(payload.bindings)
          flushAuthored(world)
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
    knownEventCount: myKnownCount,
    bindings: localBindings
  } satisfies HelloMessage)

  if (wantReplay) await replayPromise

  return { connection, network, remoteDID: connection.remoteDID, replayedEventCount }
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
