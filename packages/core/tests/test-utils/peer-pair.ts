/**
 * Two-peer (and N-peer) test harness — core-only.
 *
 * Uses anonymous agents + the unsigned in-memory transport. Core tests
 * exercise engine semantics (replication, governance, snapshot) without
 * crypto. The `@connectionengine/local` package has its own signed-transport
 * harness for tests that need real Ed25519 signatures + ZCAP capabilities.
 *
 * Almost every interesting bug in this system lives at the seam between
 * peers, so the harness is the single most-used fixture in the codebase.
 */

import { createManualClock, type ManualClock } from '../../src/ecs/clock'
import { createEngine } from '../../src/ecs/engine'
import { createAnonAgent, createWorld, destroyWorld, type World } from '../../src/ecs/world'
import { runSystems } from '../../src/ecs/system'
import { flushAuthored, flushRuntime } from '../../src/network/mutation'
import { createPeer, createUser } from '../../src/network/peer'
import {
  connectInMemory,
  type ConnectInMemoryOptions,
  type MemoryConnectionPair
} from '../../src/testing/connect-memory'
import { flushAsync } from '../../src/network/transport'

/** Bootstrap a world's local user + peer so `spawnPrefab` and the authority
 *  pipeline have a default identity to work with. */
const bootstrapIdentity = (world: World, name: string): void => {
  const user = createUser(world, { did: world.localAgent.did, asLocal: true })
  createPeer(world, { user, peerId: `${name}-p`, asLocal: true })
}

export interface PeerHandle {
  name: string
  world: World
  clock: ManualClock
}

export interface PeerPair {
  a: PeerHandle
  b: PeerHandle
  link: MemoryConnectionPair
  /** Advance both clocks, run one frame on both, await async transport. */
  tick(deltaSeconds?: number): Promise<void>
  /** Drain any pending receives without ticking systems. */
  flush(): Promise<void>
  /** Destroy both worlds + close the link. */
  dispose(): void
}

export interface CreatePeerPairOptions {
  /** Passed straight to `connectInMemory`: latency, runtime components, and
   *  the network behaviours each side is built with. */
  transport?: ConnectInMemoryOptions
  /** Names — also used as deterministic seeds for the anonymous agents. */
  names?: [string, string]
  /** Starting wall-clock time for both peers. */
  startTime?: number
}

export const createPeerPair = (options: CreatePeerPairOptions = {}): PeerPair => {
  const [nameA, nameB] = options.names ?? ['alice', 'bob']
  const start = options.startTime ?? 0
  // Each peer gets its own engine — clocks, time, and bitECS storage are
  // engine-level. Identity caches live as per-engine WeakMaps on the
  // UIDComponent / BelongsTo definitions, so the two engines stay isolated
  // even though the definitions are shared.
  const clockA = createManualClock(start)
  const clockB = createManualClock(start)
  const engineA = createEngine({ clock: clockA })
  const engineB = createEngine({ clock: clockB })
  const worldA = createWorld({ engine: engineA, agent: createAnonAgent(nameA) })
  const worldB = createWorld({ engine: engineB, agent: createAnonAgent(nameB) })
  bootstrapIdentity(worldA, nameA)
  bootstrapIdentity(worldB, nameB)
  const link = connectInMemory(worldA, worldB, options.transport)

  return {
    a: { name: nameA, world: worldA, clock: clockA },
    b: { name: nameB, world: worldB, clock: clockB },
    link,
    tick: async (deltaSeconds = 1 / 60) => {
      clockA.advance(deltaSeconds * 1000)
      clockB.advance(deltaSeconds * 1000)
      runSystems(worldA, deltaSeconds)
      runSystems(worldB, deltaSeconds)
      // runSystems is pure ECS. The harness drives the network flush after
      // the frame settles. Authored first so receivers see new entities
      // before binary packets reference them.
      flushAuthored(worldA)
      flushRuntime(worldA)
      flushAuthored(worldB)
      flushRuntime(worldB)
      await flushAsync()
    },
    flush: async () => {
      await flushAsync()
    },
    dispose: () => {
      link.close()
      destroyWorld(worldA)
      destroyWorld(worldB)
    }
  }
}

export interface PeerMesh {
  peers: PeerHandle[]
  links: MemoryConnectionPair[]
  tick(deltaSeconds?: number): Promise<void>
  flush(): Promise<void>
  dispose(): void
}

export const createPeerMesh = (n: number, options: CreatePeerPairOptions = {}): PeerMesh => {
  const peers: PeerHandle[] = []
  const start = options.startTime ?? 0
  // Each peer gets its own engine — see createPeerPair for the rationale.
  for (let i = 0; i < n; i++) {
    const name = `peer-${i}`
    const clock = createManualClock(start)
    const engine = createEngine({ clock })
    const world = createWorld({ engine, agent: createAnonAgent(name) })
    bootstrapIdentity(world, name)
    peers.push({ name, world, clock })
  }
  const links: MemoryConnectionPair[] = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      links.push(connectInMemory(peers[i].world, peers[j].world, options.transport))
    }
  }
  return {
    peers,
    links,
    tick: async (deltaSeconds = 1 / 60) => {
      for (const p of peers) {
        p.clock.advance(deltaSeconds * 1000)
        runSystems(p.world, deltaSeconds)
        flushAuthored(p.world)
        flushRuntime(p.world)
      }
      await flushAsync()
    },
    flush: async () => {
      await flushAsync()
    },
    dispose: () => {
      for (const l of links) l.close()
      for (const p of peers) destroyWorld(p.world)
    }
  }
}
