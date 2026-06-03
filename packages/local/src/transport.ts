/**
 * Local in-memory transport with Ed25519 signing.
 *
 * Stacks on top of core's in-memory transport semantics, but adds per-event
 * signing on outbound and signature verification on inbound. This is the
 * solo/local equivalent of what AD4M's Languages do for distributed sessions.
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
 * verified → applied. Tampered events are silently dropped (and emit a
 * `mutation.reject` trace event with reason `signature`).
 */

import type { AuthoredEnvelope, AuthoredEvent, Connection, RuntimeEnvelope, World } from '@connectionengine/core'
import { applyAuthoredEnvelope, applyRuntimeEnvelope } from '@connectionengine/core'
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

export interface LocalConnectionPair {
  a: Connection
  b: Connection
  close(): void
}

export interface ConnectLocalOptions {
  /** Optional governance gate per authored event (applied after verification). */
  validate?: (world: World, event: AuthoredEvent) => boolean
  /** Optional simulated latency in ms. */
  latencyMs?: number
}

type Envelope = SignedAuthoredEnvelope | RuntimeEnvelope
const isSignedAuthored = (e: Envelope): e is SignedAuthoredEnvelope =>
  Array.isArray((e as SignedAuthoredEnvelope).signedEvents)

/**
 * Wire two worlds together over an in-memory channel with Ed25519 signing.
 *
 * Both worlds must have been created with a `LocalAgent` (see
 * `createLocalAgent`). The agent's keypair is used to sign outbound authored
 * events. Inbound events are verified against the event's `author` DID
 * before apply.
 */
export const connectLocalInMemory = (
  worldA: World,
  worldB: World,
  options: ConnectLocalOptions = {}
): LocalConnectionPair => {
  const keyA = assertLocalAgent(worldA)
  const keyB = assertLocalAgent(worldB)

  if (options.validate) {
    const v = options.validate
    if (!worldA.network.validateAuthored) worldA.network.validateAuthored = (e) => v(worldA, e)
    if (!worldB.network.validateAuthored) worldB.network.validateAuthored = (e) => v(worldB, e)
  }

  const deliver = (target: World, envelope: Envelope): void => {
    const dispatch = () => {
      if (isSignedAuthored(envelope)) {
        const unwrapped = verifyAndUnwrap(target, envelope)
        if (unwrapped) applyAuthoredEnvelope(target, unwrapped)
      } else {
        applyRuntimeEnvelope(target, envelope)
      }
    }
    if (options.latencyMs && options.latencyMs > 0) setTimeout(dispatch, options.latencyMs)
    else queueMicrotask(dispatch)
  }

  const a: Connection = {
    peer: 0,
    backend: 'memory',
    send: (payload) => deliver(worldB, payload as Envelope),
    close: () => {
      worldA.network.connections.delete(a)
    }
  }
  const b: Connection = {
    peer: 0,
    backend: 'memory',
    send: (payload) => deliver(worldA, payload as Envelope),
    close: () => {
      worldB.network.connections.delete(b)
    }
  }

  worldA.network.connections.add(a)
  worldB.network.connections.add(b)

  installSigningFanout(worldA, keyA)
  installSigningFanout(worldB, keyB)

  return {
    a,
    b,
    close: () => {
      a.close()
      b.close()
    }
  }
}

const installedSigning = new WeakSet<World>()
const installSigningFanout = (world: World, kp: KeyPair): void => {
  if (installedSigning.has(world)) return
  installedSigning.add(world)
  world.network.publishAuthored = (envelope) => {
    const signed = signEnvelope(envelope, kp)
    for (const conn of world.network.connections) conn.send(signed)
  }
  world.network.publishRuntime = (envelope) => {
    // Runtime packets currently unsigned — they're authority-checked at the
    // ECS level (AuthoritativeFor), and a signature per 60Hz packet is wasteful.
    // Higher security needs would add a per-packet HMAC.
    for (const conn of world.network.connections) conn.send(envelope)
  }
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
