/**
 * A local in-memory transport with Ed25519 signing.
 *
 * It wraps `connectInMemory` from core, and adds per-event signing on the
 * outbound path and signature verification on the inbound path. Runtime binary
 * packets travel unsigned. The ECS level checks their authority through
 * `AuthoritativeFor`, and one signature per packet at the simulation tick rate
 * costs too much. A flow that needs more security would add a per-packet HMAC
 * at a different layer.
 *
 * Two-peer use:
 *
 *   const aliceAgent = createLocalAgent({ seed: 'alice' })
 *   const bobAgent   = createLocalAgent({ seed: 'bob' })
 *   const worldA = createWorld({ engine: createEngine(), agent: aliceAgent })
 *   const worldB = createWorld({ engine: createEngine(), agent: bobAgent })
 *   connectLocalInMemory(worldA, worldB)
 *
 * After that call, each setComponent on worldA is signed, delivered to worldB,
 * verified, and applied. A tampered event drops silently.
 */

import type {
  AuthoredEnvelope,
  AuthoredEvent,
  Connection,
  ConnectInMemoryOptions,
  PublishAuthored,
  World
} from '@connectionengine/core'
import { applyAuthoredEnvelope, connectInMemory, getNetwork, type MemoryConnectionPair } from '@connectionengine/core'
import { type KeyPair, fromHex, sign, stableStringify, toHex, verifyByDID } from './did'
import type { LocalAgent } from './agent'

// ── Signed wire shape ─────────────────────────────────────────────────────────

export interface SignedEvent extends AuthoredEvent {
  signature: string
}

export interface SignedAuthoredEnvelope {
  signedEvents: SignedEvent[]
  fromPeer: string
}

const canonicalise = (event: AuthoredEvent): Uint8Array =>
  new TextEncoder().encode(
    stableStringify({
      author: event.author,
      entityPath: event.entityPath,
      op: event.op,
      predicate: event.predicate,
      timestamp: event.timestamp,
      value: event.value
    })
  )

const signEvent = (event: AuthoredEvent, kp: KeyPair): SignedEvent => ({
  ...event,
  signature: toHex(sign(canonicalise(event), kp.privateKey))
})

const verifyEvent = (signed: SignedEvent): boolean => {
  const { signature, ...event } = signed
  return verifyByDID(fromHex(signature), canonicalise(event), event.author)
}

const signEnvelope = (envelope: AuthoredEnvelope, kp: KeyPair): SignedAuthoredEnvelope => ({
  signedEvents: envelope.events.map((e) => signEvent(e, kp)),
  fromPeer: envelope.fromPeer
})

const verifyAndUnwrap = (signed: SignedAuthoredEnvelope): AuthoredEnvelope | null => {
  const valid: AuthoredEvent[] = []
  let rejected = 0
  for (const se of signed.signedEvents) {
    if (verifyEvent(se)) {
      const { signature: _sig, ...event } = se
      valid.push(event)
    } else {
      rejected++
    }
  }
  if (rejected > 0 && valid.length === 0) return null
  return { events: valid, fromPeer: signed.fromPeer }
}

// ── Connection pair ───────────────────────────────────────────────────────────

export type LocalConnectionPair = MemoryConnectionPair

/**
 * The signing publisher is what this transport is for, so it is not one of the
 * behaviours a caller may supply. Everything else passes through to
 * `connectInMemory`.
 */
export type ConnectLocalOptions = Omit<ConnectInMemoryOptions, 'onPublishAuthored'>

/**
 * The outbound authored path of this transport: sign every event with the
 * keypair of the local agent, then fan the signed envelope across the
 * connections of the network.
 *
 * It reads the keypair from the world it is handed, so one function serves
 * every world. Supply it when the network is built:
 *
 *   ensureDefaultNetwork(world, { onPublishAuthored: publishSigned })
 */
export const publishSigned: PublishAuthored = (world, network, envelope) => {
  const signed = signEnvelope(envelope, assertLocalAgent(world))
  for (const conn of network.connections) conn.events.send(signed)
}

const isSignedAuthored = (payload: unknown): payload is SignedAuthoredEnvelope =>
  !!payload && typeof payload === 'object' && Array.isArray((payload as { signedEvents?: unknown }).signedEvents)

/**
 * Link two worlds over an in-memory channel, with Ed25519 signing on the
 * authored channel. The runtime SoA deltas flow over the unsigned binary
 * pipeline, and the ECS level checks their authority.
 *
 * A `LocalAgent` must have created both worlds. See `createLocalAgent`. The
 * keypair of the agent signs each outbound authored envelope. Each inbound
 * envelope is verified against `event.author` before the apply step.
 */
export const connectLocalInMemory = (
  worldA: World,
  worldB: World,
  options: ConnectLocalOptions = {}
): LocalConnectionPair => {
  // Fail early and by name when either side lacks a keypair, rather than on the
  // first publish.
  assertLocalAgent(worldA)
  assertLocalAgent(worldB)

  // Core handles the runtime fanout, the memory transport, and the lifecycle.
  // The signing publisher goes in as the outbound authored path of each side.
  // A world from `createLocalRuntime` already has it, and supplies the same
  // function, so either creation order gives the same behaviour.
  const pair = connectInMemory(worldA, worldB, { ...options, onPublishAuthored: publishSigned })

  // Add a side-channel listener to each connection. It recognises a signed
  // authored envelope, which is the only payload shape that connectInMemory
  // does not already understand. The listener verifies the envelope, unwraps
  // it, and applies it.
  attachVerifier(worldA, pair.a)
  attachVerifier(worldB, pair.b)

  return pair
}

const attachVerifier = (world: World, connection: Connection): void => {
  const network = getNetwork(world, 'default')
  connection.events.onMessage((payload) => {
    if (!isSignedAuthored(payload)) return
    const unwrapped = verifyAndUnwrap(payload)
    if (unwrapped) applyAuthoredEnvelope(world, unwrapped, network)
  })
}

const assertLocalAgent = (world: World): KeyPair => {
  const agent = world.localAgent as LocalAgent
  if (!agent || !agent.keyPair) {
    throw new Error(
      'connectLocalInMemory: both worlds must be created with createLocalAgent (got an agent without a keyPair)'
    )
  }
  return agent.keyPair
}
