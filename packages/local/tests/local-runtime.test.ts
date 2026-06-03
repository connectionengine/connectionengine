/**
 * Local-runtime two-peer scenarios — exercises the full Ed25519-signed wire.
 *
 * Validates that:
 *   - signed events authored on A are delivered + applied on B
 *   - tampered envelopes are rejected (signature.verify fails)
 *   - capability constraints reject events from peers without the right cap
 */

import { describe, expect, it } from 'vitest'
import {
  createWorld,
  destroyWorld,
  defineComponent,
  getComponent,
  setComponent,
  createNamedEntity,
  createEntity,
  getEntityByUID,
  setUID,
  runSystems,
  Schema,
  createManualClock,
  applyAuthoredEnvelope
} from '@connectionengine/core'
import {
  addCapabilityConstraint,
  connectLocalInMemory,
  createLocalAgent,
  createLocalRuntime,
  createRootCapability,
  fromHex,
  installCapabilityValidator,
  sign,
  stableStringify,
  toHex,
  verifyByDID
} from '../src'

// Components used across tests
const Health = defineComponent({
  id: 'L.Health',
  schema: Schema.Object({
    current: Schema.Number({ default: 100 }),
    max: Schema.Number({ default: 100 })
  })
})

const tick = async (
  worlds: Array<{ world: ReturnType<typeof createWorld>; clock: ReturnType<typeof createManualClock> }>
) => {
  for (const { world, clock } of worlds) {
    clock.advance(1000 / 60)
    runSystems(world, 1 / 60)
  }
  await new Promise<void>((r) => queueMicrotask(r))
}

describe('Local runtime — signed two-peer replication', () => {
  it('Ed25519-signed events propagate from A to B and apply', async () => {
    const clockA = createManualClock(0)
    const clockB = createManualClock(0)
    const agentA = createLocalAgent({ seed: 'alice' })
    const agentB = createLocalAgent({ seed: 'bob' })
    const worldA = createWorld({ agent: agentA, clock: clockA })
    const worldB = createWorld({ agent: agentB, clock: clockB })
    connectLocalInMemory(worldA, worldB)

    const scene = createNamedEntity(worldA, 'scene:local')
    const avatar = createEntity(worldA)
    setUID(worldA, avatar, 'avatar:alice', { parent: scene })
    setComponent(worldA, avatar, Health, { current: 77 })

    await tick([
      { world: worldA, clock: clockA },
      { world: worldB, clock: clockB }
    ])

    const bScene = getEntityByUID(worldB, worldB.worldRoot, 'scene:local')!
    const bAva = getEntityByUID(worldB, bScene, 'avatar:alice')!
    expect(getComponent(worldB, bAva, Health)).toEqual({ current: 77, max: 100 })
    // event log captured on both sides
    expect(worldB.eventLog.length).toBeGreaterThan(0)
    for (const evt of worldB.eventLog) expect(evt.author).toBe(agentA.did)

    destroyWorld(worldA)
    destroyWorld(worldB)
  })

  it('tampered signatures fail verification', () => {
    const malicious = createLocalAgent({ seed: 'tamper-mallory' })
    const realEvent = {
      entityPath: ['scene:tamper', 'x'],
      predicate: 'L.Health',
      op: 'set' as const,
      value: { current: 10 },
      author: malicious.did,
      timestamp: 1000
    }
    const canonical = (value: typeof realEvent): Uint8Array =>
      new TextEncoder().encode(
        stableStringify({
          author: value.author,
          entityPath: value.entityPath,
          op: value.op,
          predicate: value.predicate,
          timestamp: value.timestamp,
          value: value.value
        })
      )
    // Sign the original bytes, then tamper the value.
    const signature = toHex(sign(canonical(realEvent), malicious.keyPair.privateKey))
    const tampered = { ...realEvent, value: { current: 99999 } }
    // Verification against the tampered bytes fails (signature was over the
    // original).
    expect(verifyByDID(fromHex(signature), canonical(tampered), realEvent.author)).toBe(false)
    // Sanity: the same signature verifies against the original bytes.
    expect(verifyByDID(fromHex(signature), canonical(realEvent), realEvent.author)).toBe(true)
  })

  it('createLocalRuntime convenience wires agent + governance', () => {
    const { world, agent } = createLocalRuntime({ seed: 'convenience' })
    expect(world.localAgent).toBe(agent)
    // governance was installed on the default network (validateAuthored is set)
    expect(world.networks.get('default')?.validateAuthored).toBeDefined()
    destroyWorld(world)
  })
})

describe('Local runtime — capability governance', () => {
  it('capability constraint rejects events from peer without matching cap', async () => {
    const clockA = createManualClock(0)
    const clockB = createManualClock(0)
    const aliceAgent = createLocalAgent({ seed: 'cap-alice' })
    const bobAgent = createLocalAgent({ seed: 'cap-bob' })
    const worldA = createWorld({ agent: aliceAgent, clock: clockA })
    const worldB = createWorld({ agent: bobAgent, clock: clockB })

    // Alice has a self-issued root capability for L.Health under scene:cap
    const aliceCap = createRootCapability({
      invoker: aliceAgent.keyPair.did,
      predicates: ['L.Health'],
      scope: ['scene:cap'],
      issuer: aliceAgent.keyPair
    })

    // Install governance on both peers — they trust Alice's DID as issuer.
    installCapabilityValidator(worldA, { trustedIssuers: [aliceAgent.keyPair.did] })
    installCapabilityValidator(worldB, { trustedIssuers: [aliceAgent.keyPair.did] })

    connectLocalInMemory(worldA, worldB)

    const scene = createNamedEntity(worldA, 'scene:cap')
    addCapabilityConstraint(worldA, scene, aliceCap)
    const ava = createEntity(worldA)
    setUID(worldA, ava, 'avatar', { parent: scene })
    setComponent(worldA, ava, Health, { current: 50 })

    await tick([
      { world: worldA, clock: clockA },
      { world: worldB, clock: clockB }
    ])

    // Bob's world has the constraint + initial Health
    const bScene = getEntityByUID(worldB, worldB.worldRoot, 'scene:cap')!
    const bAva = getEntityByUID(worldB, bScene, 'avatar')!
    expect(getComponent(worldB, bAva, Health)?.current).toBe(50)

    // Bob (no cap) attempts to modify Health — locally succeeds, but Alice's world rejects
    setComponent(worldB, bAva, Health, { current: 9999 })
    await tick([
      { world: worldA, clock: clockA },
      { world: worldB, clock: clockB }
    ])

    expect(getComponent(worldA, ava, Health)?.current).toBe(50)
    const rejects = worldA.trace.byKind('governance.reject')
    expect(rejects.length).toBeGreaterThan(0)

    destroyWorld(worldA)
    destroyWorld(worldB)
  })
})

// Direct apply path used as a baseline (no transport)
describe('Local runtime — direct envelope apply', () => {
  it('applyAuthoredEnvelope rejects events failing validateAuthored', () => {
    const { world } = createLocalRuntime({ seed: 'baseline' })
    const network = world.networks.get('default')!
    const evRejecter = network.validateAuthored
    // Install a deny-all gate for this test
    network.validateAuthored = () => false
    applyAuthoredEnvelope(
      world,
      {
        fromPeer: 'did:test:other',
        events: [
          {
            entityPath: ['x'],
            predicate: 'L.Health',
            op: 'set',
            value: { current: 1 },
            author: 'did:test:other',
            timestamp: 0
          }
        ]
      },
      network
    )
    const rejects = world.trace.byKind('mutation.reject')
    expect(rejects.some((r) => r.detail?.reason === 'governance')).toBe(true)
    network.validateAuthored = evRejecter
    destroyWorld(world)
  })
})
