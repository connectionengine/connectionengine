/**
 * Peer connection lifecycle — join / leave / late-join replay.
 *
 * `joinWorld(world, { endpoint })` performs a three-step session handshake
 * over a `TransportEndpoint`, then (optionally) replays the remote peer's
 * authored event log to bring the local world to a converged state. This is
 * **pure event-sourced bootstrap** — no snapshot exchange; the joiner
 * reconstructs state by replaying signed events in order.
 *
 *   1. HELLO   — exchange { agentDID, peerEntityPath, knownEventCount }
 *   2. REPLAY  — host streams its eventLog (from joiner's known cursor) in
 *                ordered chunks; joiner applies each with origin='network'.
 *                Idempotent: events already applied (matched by signature)
 *                are skipped.
 *   3. LIVE    — both sides switch to forwarding their authored / runtime
 *                envelopes through the same endpoint.
 *
 * `leaveWorld(world, connection)` closes the endpoint and runs the deep
 * disconnect cleanup: if the leaving peer was the last live peer of its
 * user, every entity OwnedBy that user tagged TransientOnDisconnect is
 * removed.
 */

import type { AuthoredEnvelope, AuthoredEvent, Connection, Entity, RuntimeEnvelope, World } from '../ecs/world'
import { applyAuthoredEnvelope, applyRuntimeEnvelope, flushAuthored } from '../engine/mutation'
import { createEntity, removeEntity } from '../ecs/entity'
import type { TransportEndpoint } from './transport'
import { getOwner } from './authority'
import { TransientOnDisconnect } from './peer'
import { componentEntities, hasComponent } from '../ecs/component'

// ── Session message shapes ────────────────────────────────────────────────────

interface HelloMessage {
  type: 'hello'
  agentDID: string
  /** Index of the last authored event the joiner already has (0 = full replay). */
  knownEventCount: number
}

interface ReplayChunk {
  type: 'replay-chunk'
  events: AuthoredEvent[]
}

interface ReplayEndMessage {
  type: 'replay-end'
  totalEvents: number
}

interface LeaveMessage {
  type: 'leave'
  agentDID: string
}

type ControlMessage = HelloMessage | ReplayChunk | ReplayEndMessage | LeaveMessage

const isControl = (payload: unknown): payload is ControlMessage =>
  !!payload && typeof payload === 'object' && typeof (payload as { type?: unknown }).type === 'string'

// ── Applied-event dedupe ──────────────────────────────────────────────────────

/**
 * Per-world set of signatures for events that have already been applied.
 * Used to skip duplicates during late-join replay (events the joiner already
 * has, or events delivered both through replay and the live stream during the
 * handover window).
 *
 * Signature is (author, timestamp, op, predicate, entityPath) — sufficient
 * to dedupe in practice; conflicts only if the same author authors two
 * different events at the exact same ms timestamp on the same predicate+path.
 */
const appliedSignatures = new WeakMap<World, Set<string>>()

const eventSignature = (e: AuthoredEvent): string =>
  `${e.author}|${e.timestamp}|${e.op}|${e.predicate}|${e.entityPath.join('/')}|${JSON.stringify(e.value ?? null)}`

const recordApplied = (world: World, e: AuthoredEvent): void => {
  let set = appliedSignatures.get(world)
  if (!set) {
    set = new Set()
    appliedSignatures.set(world, set)
  }
  set.add(eventSignature(e))
}

const isAlreadyApplied = (world: World, e: AuthoredEvent): boolean =>
  appliedSignatures.get(world)?.has(eventSignature(e)) === true

/** Seed dedupe set from the existing event log. Called on world wire-up. */
const seedDedupe = (world: World): void => {
  let set = appliedSignatures.get(world)
  if (set) return
  set = new Set()
  for (const e of world.eventLog) set.add(eventSignature(e))
  appliedSignatures.set(world, set)
}

// ── Join / leave ──────────────────────────────────────────────────────────────

export interface JoinWorldOptions {
  endpoint: TransportEndpoint
  /** Replay remote event log on join. Default true. */
  replayEventLog?: boolean
  /** Cursor: skip events at or before this index in the remote log. Default 0. */
  knownEventCount?: number
  /** Hard cap on events streamed per chunk during replay. Default 256. */
  replayChunkSize?: number
}

export interface JoinResult {
  /** The Connection registered in `world.network.connections`. */
  connection: Connection
  /** Remote agent DID (discovered during handshake). */
  remoteDID: string
  /** Number of events the joiner applied during catch-up. */
  replayedEventCount: number
}

/**
 * Bring the local world up to date with the remote peer over `endpoint`.
 *
 * Resolves after the replay phase completes; subsequent live envelopes flow
 * through the same endpoint without further setup.
 */
export const joinWorld = async (world: World, options: JoinWorldOptions): Promise<JoinResult> => {
  const { endpoint } = options
  const replay = options.replayEventLog !== false
  const chunkSize = options.replayChunkSize ?? 256
  const myKnownCount = options.knownEventCount ?? 0

  seedDedupe(world)
  installLifecycleFanout(world)

  let remoteDID = 'did:unknown:pending'
  let replayedEventCount = 0
  let replayDone = false
  let resolveReplay!: () => void
  const replayPromise = new Promise<void>((r) => {
    resolveReplay = r
  })

  // The Connection we'll register; remoteDID is filled in by hello.
  const connection: Connection & { remoteDID?: string } = {
    peer: 0,
    backend: endpoint.backend,
    send: (payload) => endpoint.send(payload),
    close: () => {
      world.network.connections.delete(connection)
      endpoint.close()
    }
  }

  // Wire incoming
  endpoint.onMessage((payload) => {
    if (isControl(payload)) {
      switch (payload.type) {
        case 'hello':
          remoteDID = payload.agentDID
          connection.remoteDID = remoteDID
          // Drain any pending authored writes into the event log before responding,
          // so the replay sees state-of-the-moment rather than pre-flush state.
          flushAuthored(world)
          // Reciprocate: if remote asked for events we have, start streaming them
          if (replay && payload.knownEventCount < world.eventLog.length) {
            streamEventLog(world, endpoint, payload.knownEventCount, chunkSize)
          } else if (replay) {
            endpoint.send({ type: 'replay-end', totalEvents: world.eventLog.length } satisfies ReplayEndMessage)
          }
          break
        case 'replay-chunk':
          for (const event of payload.events) {
            if (isAlreadyApplied(world, event)) continue
            applyAuthoredEnvelope(world, { fromPeer: remoteDID, events: [event] })
            recordApplied(world, event)
            replayedEventCount++
          }
          break
        case 'replay-end':
          replayDone = true
          resolveReplay()
          break
        case 'leave':
          // Remote initiated graceful disconnect
          cleanupRemotePeer(world, connection)
          connection.close()
          break
      }
      return
    }
    // Live envelope
    const env = payload as AuthoredEnvelope | RuntimeEnvelope
    if (Array.isArray((env as AuthoredEnvelope).events)) {
      const authored = env as AuthoredEnvelope
      // Filter out events already in our log (handover race)
      const fresh = authored.events.filter((e) => !isAlreadyApplied(world, e))
      if (fresh.length === 0) return
      applyAuthoredEnvelope(world, { fromPeer: authored.fromPeer, events: fresh })
      for (const e of fresh) recordApplied(world, e)
    } else {
      applyRuntimeEnvelope(world, env as RuntimeEnvelope)
    }
  })

  endpoint.onClose(() => {
    cleanupRemotePeer(world, connection)
    world.network.connections.delete(connection)
  })

  world.network.connections.add(connection)

  // Send our hello
  endpoint.send({
    type: 'hello',
    agentDID: world.network.localAgent.did,
    knownEventCount: myKnownCount
  } satisfies HelloMessage)

  if (replay) {
    // Wait for the remote's replay-end signal. If they have nothing to replay
    // they still send replay-end immediately.
    await replayPromise
    void replayDone
  }

  return { connection, remoteDID, replayedEventCount }
}

const streamEventLog = (world: World, endpoint: TransportEndpoint, fromIndex: number, chunkSize: number): void => {
  const events = world.eventLog.slice(fromIndex)
  for (let i = 0; i < events.length; i += chunkSize) {
    endpoint.send({ type: 'replay-chunk', events: events.slice(i, i + chunkSize) } satisfies ReplayChunk)
  }
  endpoint.send({ type: 'replay-end', totalEvents: world.eventLog.length } satisfies ReplayEndMessage)
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
  cleanupRemotePeer(world, connection)
  connection.close()
}

// ── Lifecycle fanout — install once per world ─────────────────────────────────

const installedLifecycle = new WeakSet<World>()
const installLifecycleFanout = (world: World): void => {
  if (installedLifecycle.has(world)) return
  installedLifecycle.add(world)
  // Forward outbound authored / runtime envelopes through every connection.
  // Tag events as applied locally so the dedupe set knows we've seen them.
  const seedTracker = (events: AuthoredEvent[]): void => {
    for (const e of events) recordApplied(world, e)
  }
  world.network.publishAuthored = (envelope) => {
    seedTracker(envelope.events)
    for (const conn of world.network.connections) conn.send(envelope)
  }
  world.network.publishRuntime = (envelope) => {
    for (const conn of world.network.connections) conn.send(envelope)
  }
}

// ── Deep disconnect cleanup (Spec 06 R11 + R13) ──────────────────────────────-

/**
 * Track connection → remote peer entity. Populated lazily after handshake
 * (via the remoteDID) when a corresponding peer entity exists in this world.
 */
const remotePeerOf = new WeakMap<Connection, Entity>()

/** Associate a connection with the local entity representing the remote peer. */
export const setRemotePeer = (connection: Connection, peerEntity: Entity): void => {
  remotePeerOf.set(connection, peerEntity)
}

const cleanupRemotePeer = (world: World, connection: Connection): void => {
  const remoteDID = (connection as Connection & { remoteDID?: string }).remoteDID
  if (!remoteDID) return

  // Find the user entity for this DID
  const userEntity = findUserByDID(world, remoteDID)
  if (userEntity === undefined) return

  // Does this user still have any other live connections?
  for (const otherConn of world.network.connections) {
    if (otherConn === connection) continue
    const otherDID = (otherConn as Connection & { remoteDID?: string }).remoteDID
    if (otherDID && findUserByDID(world, otherDID) === userEntity) return
  }

  // No other peers for this user — sweep TransientOnDisconnect entities they own
  for (const candidate of componentEntities(world, TransientOnDisconnect)) {
    if (getOwner(world, candidate) !== userEntity) continue
    removeEntity(world, candidate)
  }
}

// Lazy import to avoid cycle with peer.ts
import { UserComponent } from './peer'
import { getComponent } from '../ecs/component'

const findUserByDID = (world: World, did: string): Entity | undefined => {
  for (const e of componentEntities(world, UserComponent)) {
    const u = getComponent(world, e, UserComponent) as { did?: string } | undefined
    if (u?.did === did) return e
  }
  return undefined
}

// silence intentionally-unused
void createEntity
void hasComponent
