/**
 * Local in-memory transport with Ed25519 signing.
 *
 * Wraps core's `connectInMemory` to add per-event signing on outbound and
 * signature verification on inbound. Runtime binary packets travel unsigned
 * — they're authority-checked at the ECS level via `AuthoritativeFor`, and
 * a signature per 60 Hz packet is too costly. Higher-security flows would
 * add a per-packet HMAC at a different layer.
 *
 * Two-peer use:
 *
 *   const aliceAgent = createLocalAgent({ seed: 'alice' })
 *   const bobAgent   = createLocalAgent({ seed: 'bob' })
 *   const worldA = createWorld({ agent: aliceAgent })
 *   const worldB = createWorld({ agent: bobAgent })
 *   connectLocalInMemory(worldA, worldB)
 *
 * After this, any setComponent on worldA → signed → delivered to worldB →
 * verified → applied. Tampered events are dropped (emit a `mutation.reject`
 * trace event with `reason: 'signature'`).
 */

import type { AuthoredEnvelope, AuthoredEvent, Connection, World } from '@connectionengine/core'
import { applyAuthoredEnvelope, connectInMemory, type MemoryConnectionPair } from '@connectionengine/core'
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

const verifyAndUnwrap = (world: World, signed: SignedAuthoredEnvelope): AuthoredEnvelope | null => {
  const valid: AuthoredEvent[] = []
  let rejected = 0
  for (const se of signed.signedEvents) {
    if (verifyEvent(se)) {
      const { signature: _sig, ...event } = se
      valid.push(event)
    } else {
      rejected++
      world.trace.emit({
        kind: 'mutation.reject',
        ts: world.clock.now(),
        predicate: se.predicate,
        detail: { reason: 'signature' }
      })
    }
  }
  if (rejected > 0 && valid.length === 0) return null
  return { events: valid, fromPeer: signed.fromPeer }
}

// ── Connection pair ───────────────────────────────────────────────────────────

export type LocalConnectionPair = MemoryConnectionPair

export interface ConnectLocalOptions {
  /** Optional governance gate per authored event (applied after verification). */
  validate?: (world: World, event: AuthoredEvent) => boolean
  /** Optional simulated latency in ms. */
  latencyMs?: number
}

const isSignedAuthored = (payload: unknown): payload is SignedAuthoredEnvelope =>
  !!payload && typeof payload === 'object' && Array.isArray((payload as { signedEvents?: unknown }).signedEvents)

/**
 * Wire two worlds together over an in-memory channel with Ed25519 signing on
 * the authored channel. Runtime SoA deltas flow over the unsigned binary
 * pipeline (authority-checked at ECS level).
 *
 * Both worlds must have been created with a `LocalAgent` (see
 * `createLocalAgent`). The agent's keypair signs outbound authored envelopes;
 * inbound envelopes are verified against `event.author` before apply.
 */
export const connectLocalInMemory = (
  worldA: World,
  worldB: World,
  options: ConnectLocalOptions = {}
): LocalConnectionPair => {
  const keyA = assertLocalAgent(worldA)
  const keyB = assertLocalAgent(worldB)

  // Delegate runtime fanout + memory transport + lifecycle to core. We override
  // each world's publishAuthored hook to interpose signing.
  const pair = connectInMemory(worldA, worldB, {
    validate: options.validate,
    latencyMs: options.latencyMs
  })

  installSigningOverride(worldA, keyA)
  installSigningOverride(worldB, keyB)

  // Add a side-channel listener on each connection that recognises signed
  // authored envelopes (the only payload shape connectInMemory doesn't
  // already understand) — verify, unwrap, apply.
  attachVerifier(worldA, pair.a)
  attachVerifier(worldB, pair.b)

  return pair
}

const installSigningOverride = (world: World, kp: KeyPair): void => {
  // Replace authored fanout with signing fanout. Runtime hook untouched —
  // core's installFanout already wired publishRuntime to the binary channel.
  world.network.publishAuthored = (envelope: AuthoredEnvelope) => {
    const signed = signEnvelope(envelope, kp)
    for (const conn of world.network.connections) conn.send(signed)
  }
}

const attachVerifier = (world: World, connection: Connection): void => {
  connection.onMessage((payload) => {
    if (!isSignedAuthored(payload)) return
    const unwrapped = verifyAndUnwrap(world, payload)
    if (unwrapped) applyAuthoredEnvelope(world, unwrapped)
  })
}

const assertLocalAgent = (world: World): KeyPair => {
  const agent = world.network.localAgent as LocalAgent
  if (!agent || !agent.keyPair) {
    throw new Error(
      'connectLocalInMemory: both worlds must be created with createLocalAgent (got an agent without a keyPair)'
    )
  }
  return agent.keyPair
}
