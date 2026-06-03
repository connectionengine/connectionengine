/**
 * Session — joinWorld / leaveWorld orchestration over a TransportEndpoint.
 *
 * Wire protocol (control messages are plain JS objects; runtime packets are
 * `ArrayBuffer`; authored envelopes are `{ events, fromPeer }`):
 *
 *   1. HELLO   — exchange { agentDID, knownEventCount, bindings }
 *                  bindings = local NetworkIdTable snapshot, seeds the peer's
 *                  remote table so the first binary packet resolves cleanly.
 *   2. REPLAY  — host streams its event log from joiner's known cursor as
 *                chunks; joiner applies idempotently. Replay-end signals done.
 *   3. LIVE    — both sides forward authored envelopes + runtime binary packets.
 *                Authored is rebroadcast (mesh flood) to other connections;
 *                runtime stays point-to-point.
 *
 * Disconnect → `sweepDisconnectedPeer` removes TransientOnDisconnect entities
 * owned by the leaving user if no other connection still represents them.
 */

import type { AuthoredEnvelope, Connection, World } from '../../ecs/world'
import type { ComponentDefinition } from '../../ecs/component'
import { applyAuthoredEnvelope, flushAuthored } from '../../engine/mutation'
import type { RuntimeTransportConfig, TransportEndpoint } from '../transport'
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

// ── joinWorld ────────────────────────────────────────────────────────────────-

export interface JoinWorldOptions {
  endpoint: TransportEndpoint
  /** Replay remote event log on join. Default true. */
  replayEventLog?: boolean
  /** Cursor: skip events at or before this index in the remote log. Default 0. */
  knownEventCount?: number
  /** Hard cap on events streamed per chunk during replay. Default 256. */
  replayChunkSize?: number
  /** Runtime components to wire for binary replication on this connection. */
  runtimeComponents?: readonly ComponentDefinition[]
  /** Per-component transport config (rate + full-sync interval + interpolation). */
  runtimeConfigs?: RuntimeTransportConfig[]
}

export interface JoinResult {
  connection: Connection
  remoteDID: string
  replayedEventCount: number
}

/** Promote a TransportEndpoint into a Connection with session-level metadata. */
const wrapEndpoint = (endpoint: TransportEndpoint): Connection => ({
  peer: 0,
  backend: endpoint.backend,
  remoteDID: 'did:unknown:pending',
  send: (payload) => endpoint.send(payload),
  onMessage: (h) => endpoint.onMessage(h),
  onClose: (h) => endpoint.onClose(h),
  close: () => endpoint.close()
})

/**
 * Bring the local world up to date with the remote peer over `endpoint`.
 * Resolves after the replay phase completes; live envelopes flow over the
 * same endpoint with no further setup.
 */
export const joinWorld = async (world: World, options: JoinWorldOptions): Promise<JoinResult> => {
  const { endpoint } = options
  const wantReplay = options.replayEventLog !== false
  const chunkSize = options.replayChunkSize ?? 256
  const myKnownCount = options.knownEventCount ?? 0

  installFanout(world)

  const connection = wrapEndpoint(endpoint)
  // Build a binary channel for this connection (only if runtime components were specified).
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

  endpoint.onMessage((payload) => {
    if (payload instanceof ArrayBuffer) {
      const channel = options.runtimeComponents ? getChannelOrNull(connection) : undefined
      if (channel) channel.applyBuffer(payload)
      return
    }
    if (isControl(payload)) {
      switch (payload.type) {
        case 'hello': {
          connection.remoteDID = payload.agentDID
          // Seed remote table with peer's bindings so their first binary packet resolves.
          getChannelOrNull(connection)?.registerBindings(payload.bindings)
          // Drain pending authored writes so replay reflects state-of-the-moment.
          flushAuthored(world)
          if (wantReplay && payload.knownEventCount < world.eventLog.length) {
            streamEventLog(world, endpoint, payload.knownEventCount, chunkSize)
          } else if (wantReplay) {
            endpoint.send({ type: 'replay-end', totalEvents: world.eventLog.length } satisfies ReplayEndMessage)
          }
          break
        }
        case 'replay-chunk':
          replayedEventCount += applyReplayChunk(world, connection.remoteDID, payload.events)
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
      applyAuthoredEnvelope(world, envelope)
      rebroadcastAuthored(world, connection, envelope)
      return
    }
  })

  endpoint.onClose(() => {
    sweepDisconnectedPeer(world, connection)
    world.network.connections.delete(connection)
  })

  world.network.connections.add(connection)

  // Send our hello, including current bindings so peer can decode our first packet immediately.
  const localBindings = options.runtimeComponents ? getNetworkIdTable(world).bindings() : []
  endpoint.send({
    type: 'hello',
    agentDID: world.network.localAgent.did,
    knownEventCount: myKnownCount,
    bindings: localBindings
  } satisfies HelloMessage)

  if (wantReplay) await replayPromise

  return { connection, remoteDID: connection.remoteDID, replayedEventCount }
}

/**
 * Leave a world: send a graceful-leave signal to the peer, close the endpoint,
 * run the deep disconnect cleanup locally.
 */
export const leaveWorld = async (world: World, connection: Connection): Promise<void> => {
  try {
    connection.send({ type: 'leave', agentDID: world.network.localAgent.did } satisfies LeaveMessage)
  } catch {
    // peer may already be gone
  }
  sweepDisconnectedPeer(world, connection)
  connection.close()
}

const getChannelOrNull = (connection: Connection) => getConnectionChannel(connection) ?? null
