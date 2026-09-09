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
  createEngine,
  createWorld,
  destroyWorld,
  defineComponent,
  getComponent,
  setComponent,
  spawnPrefab,
  createEntity,
  createPeer,
  createUser,
  flushAuthored,
  flushRuntime,
  getEntityByUID,
  getNetwork,
  setUID,
  runSystems,
  Schema,
  createManualClock,
  addNetwork,
  applyAuthoredEnvelope,
  validateAuthored,
  type AuthoredEvent,
  type World
} from '@connectionengine/core'
import {
  addCapabilityConstraint,
  connectLocalInMemory,
  createLocalAgent,
  createLocalRuntime,
  createRootCapability,
  capabilityGate,
  fromHex,
  setTrustedIssuers,
  sign,
  stableStringify,
  toHex,
  verifyByDID
} from '../src'

/**
 * Put `scene:gov` under a capability that only one holder satisfies, and trust
 * its issuer. Any other author writing `L.Health` under that scene then fails
 * the capability kind. Returns the path of a child entity under that scene,
 * which is what the constraint resolution walks up from.
 */
const governScene = (world: World): string[] => {
  const issuer = createLocalAgent({ seed: 'gov-issuer' })
  const holder = createLocalAgent({ seed: 'gov-holder' })
  setTrustedIssuers([issuer.keyPair.did])
  // spawnPrefab needs an owner, and createLocalRuntime leaves identity to the app.
  createUser(world, { did: world.localAgent.did, asLocal: true })
  const scene = spawnPrefab(world, 'scene:gov')
  addCapabilityConstraint(
    world,
    scene,
    createRootCapability({
      invoker: holder.keyPair.did,
      predicates: ['L.Health'],
      scope: ['scene:gov'],
      issuer: issuer.keyPair
    })
  )
  const child = createEntity(world)
  setUID(world, child, 'x', { parent: scene })
  return ['scene:gov', 'x']
}

/** An event from a DID that holds no capability, aimed at a governed path. */
const strangerEvent = (entityPath: string[]): AuthoredEvent => ({
  entityPath,
  predicate: 'L.Health',
  op: 'set',
  value: { current: 1 },
  author: 'did:test:stranger',
  timestamp: 0,
  seq: 0
})

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
    flushAuthored(world)
    flushRuntime(world)
  }
  await new Promise<void>((r) => queueMicrotask(r))
}

describe('Local runtime — signed two-peer replication', () => {
  it('Ed25519-signed events propagate from A to B and apply', async () => {
    const clockA = createManualClock(0)
    const clockB = createManualClock(0)
    const agentA = createLocalAgent({ seed: 'alice' })
    const agentB = createLocalAgent({ seed: 'bob' })
    const worldA = createWorld({ engine: createEngine({ clock: clockA }), agent: agentA })
    const worldB = createWorld({ engine: createEngine({ clock: clockB }), agent: agentB })
    const aliceUser = createUser(worldA, { did: agentA.did, asLocal: true })
    createPeer(worldA, { user: aliceUser, peerId: 'alice-p', asLocal: true })
    const bobUser = createUser(worldB, { did: agentB.did, asLocal: true })
    createPeer(worldB, { user: bobUser, peerId: 'bob-p', asLocal: true })
    connectLocalInMemory(worldA, worldB)

    const scene = spawnPrefab(worldA, 'scene:local')
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
    // Both sides authored their own identity bootstrap (createUser + createPeer).
    // assert that the avatar's events specifically came from A.
    expect(worldB.eventLog.length).toBeGreaterThan(0)
    const aliceAvatarEvents = worldB.eventLog.filter((e) =>
      e.entityPath.join('/').startsWith('scene:local/avatar:alice')
    )
    expect(aliceAvatarEvents.length).toBeGreaterThan(0)
    for (const evt of aliceAvatarEvents) expect(evt.author).toBe(agentA.did)

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
      timestamp: 1000,
      seq: 0
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
    // The capability gate went in when the network was built, so it runs. An
    // unsigned, uncapability-backed write from a stranger fails it.
    const network = getNetwork(world, 'default')!
    expect(validateAuthored(world, network, strangerEvent(governScene(world)))).toBe(false)
    destroyWorld(world)
  })

  it('createLocalRuntime with governance:false admits what the gate would refuse', () => {
    const { world } = createLocalRuntime({ seed: 'ungoverned', governance: false })
    const network = getNetwork(world, 'default')!
    expect(validateAuthored(world, network, strangerEvent(governScene(world)))).toBe(true)
    destroyWorld(world)
  })
})

describe('Local runtime — capability governance', () => {
  it('capability constraint rejects events from peer without matching cap', async () => {
    const clockA = createManualClock(0)
    const clockB = createManualClock(0)
    const aliceAgent = createLocalAgent({ seed: 'cap-alice' })
    const bobAgent = createLocalAgent({ seed: 'cap-bob' })
    const worldA = createWorld({ engine: createEngine({ clock: clockA }), agent: aliceAgent })
    const worldB = createWorld({ engine: createEngine({ clock: clockB }), agent: bobAgent })
    const aliceUser = createUser(worldA, { did: aliceAgent.did, asLocal: true })
    createPeer(worldA, { user: aliceUser, peerId: 'alice-p', asLocal: true })
    const bobUser = createUser(worldB, { did: bobAgent.did, asLocal: true })
    createPeer(worldB, { user: bobUser, peerId: 'bob-p', asLocal: true })

    // Alice has a self-issued root capability for L.Health under scene:cap
    const aliceCap = createRootCapability({
      invoker: aliceAgent.keyPair.did,
      predicates: ['L.Health'],
      scope: ['scene:cap'],
      issuer: aliceAgent.keyPair
    })

    // Both peers trust Alice as an issuer. This is process-wide deployment
    // config: peers holding different lists would disagree on the same event.
    setTrustedIssuers([aliceAgent.keyPair.did])

    // The gate is fixed when the network is built, so it goes in with the
    // connection rather than being attached afterwards.
    connectLocalInMemory(worldA, worldB, { onValidateAuthored: capabilityGate })

    const scene = spawnPrefab(worldA, 'scene:cap')
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

    destroyWorld(worldA)
    destroyWorld(worldB)
  })
})

// Direct apply path used as a baseline (no transport)
describe('Local runtime — direct envelope apply', () => {
  it('applyAuthoredEnvelope drops events failing validateAuthored', () => {
    const { world } = createLocalRuntime({ seed: 'baseline' })
    // A deny-all network. The gate cannot be swapped on an existing network, so
    // the test builds one that refuses everything.
    const network = addNetwork(world, { id: 'deny', onValidateAuthored: () => false })
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
            timestamp: 0,
            seq: 0
          }
        ]
      },
      network
    )
    // Gate rejected → event never landed in the log.
    expect(world.eventLog).toHaveLength(0)
    destroyWorld(world)
  })
})
