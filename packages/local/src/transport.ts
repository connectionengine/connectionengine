/**
 * A local in-memory transport with Ed25519 signing.
 *
 * It wraps `connectInMemory` from core, adding a signing/verification layer on
 * the transport endpoint. The memory transport creates paired endpoints; this
 * module wraps each endpoint so that outbound authored envelopes get signed and
 * inbound signed envelopes get verified and unwrapped before the session
 * protocol handles them.
 *
 * Runtime binary packets travel unsigned. The ECS level checks their authority
 * through `AuthoritativeFor`, and one signature per packet at the simulation
 * tick rate costs too much. A flow that needs more security would add a
 * per-packet HMAC at a different layer.
 *
 * Two-peer use:
 *
 *   const aliceAgent = createLocalAgent({ seed: 'alice' })
 *   const bobAgent   = createLocalAgent({ seed: 'bob' })
 *   const worldA = createWorld({ engine: createEngine(), agent: aliceAgent })
 *   const worldB = createWorld({ engine: createEngine(), agent: bobAgent })
 *   await connectLocalInMemory(worldA, worldB)
 *
 * After that call, each setComponent on worldA gets signed, delivered to worldB,
 * verified, and applied. A tampered event drops silently.
 *
 * Governance runs engine-internally. Add constraint entities to the world
 * before connecting.
 */

import type {
  AuthoredEnvelope,
  AuthoredEvent,
  ConnectInMemoryOptions,
  TransportEndpoint,
  World
} from '@connectionengine/core'
import { createMemoryTransport, ensureDefaultNetwork, isAuthoredEnvelope, joinNetwork } from '@connectionengine/core'
import type { MemoryConnectionPair } from '@connectionengine/core'
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

const isSignedAuthored = (payload: unknown): payload is SignedAuthoredEnvelope =>
  !!payload && typeof payload === 'object' && Array.isArray((payload as { signedEvents?: unknown }).signedEvents)

// ── Signing endpoint wrapper ─────────────────────────────────────────────────

/**
 * Wrap a transport endpoint with signing on the outbound path and verification
 * on the inbound path. Control messages (hello, replay, leave) pass through
 * unchanged. Only authored envelopes get signed/verified.
 */
const wrapWithSigning = (endpoint: TransportEndpoint, keyPair: KeyPair): TransportEndpoint => ({
  events: {
    send: (payload) => {
      if (isAuthoredEnvelope(payload)) {
        endpoint.events.send(signEnvelope(payload as AuthoredEnvelope, keyPair))
      } else {
        endpoint.events.send(payload)
      }
    },
    onMessage: (handler) =>
      endpoint.events.onMessage((payload) => {
        if (isSignedAuthored(payload)) {
          const unwrapped = verifyAndUnwrap(payload)
          if (unwrapped) handler(unwrapped)
          return
        }
        handler(payload)
      })
  },
  stream: endpoint.stream,
  onClose: (h) => endpoint.onClose(h),
  close: () => endpoint.close()
})

// ── Connection pair ───────────────────────────────────────────────────────────

export type LocalConnectionPair = MemoryConnectionPair

export type ConnectLocalOptions = ConnectInMemoryOptions

/**
 * Link two worlds over an in-memory channel, with Ed25519 signing on the
 * authored channel. The runtime SoA deltas flow over the unsigned binary
 * pipeline, and the ECS level checks their authority.
 *
 * A `LocalAgent` must have created both worlds. See `createLocalAgent`. The
 * keypair of the agent signs each outbound authored envelope. Each inbound
 * envelope gets verified against `event.author` before the apply step.
 *
 * Governance runs engine-internally. Add constraint entities to the world
 * before calling this function.
 */
export const connectLocalInMemory = async (
  worldA: World,
  worldB: World,
  options: ConnectLocalOptions = {}
): Promise<LocalConnectionPair> => {
  // Fail early and by name when either side lacks a keypair, rather than on the
  // first publish.
  const kpA = assertLocalAgent(worldA)
  const kpB = assertLocalAgent(worldB)

  const { latencyMs, runtimeComponents, runtimeConfigs } = options
  const transport = createMemoryTransport({ latencyMs })

  // Wrap each endpoint with signing/verification.
  const wrappedA = wrapWithSigning(transport.a, kpA)
  const wrappedB = wrapWithSigning(transport.b, kpB)

  // Each side gets its own default network — pure topology, no governance.
  const networkA = ensureDefaultNetwork(worldA)
  const networkB = ensureDefaultNetwork(worldB)

  // Both sides join simultaneously, same pattern as core's connectInMemory.
  const [resultA, resultB] = await Promise.all([
    joinNetwork(worldA, {
      endpoint: wrappedA,
      network: networkA,
      runtimeComponents,
      runtimeConfigs
    }),
    joinNetwork(worldB, {
      endpoint: wrappedB,
      network: networkB,
      runtimeComponents,
      runtimeConfigs
    })
  ])

  return {
    a: resultA.connection,
    b: resultB.connection,
    close: () => transport.close()
  }
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
