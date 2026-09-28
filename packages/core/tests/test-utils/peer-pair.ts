/**
 * Two-peer (and N-peer) test harness — core-only.
 *
 * All peers share one engine singleton. Each peer gets its own World. Entity
 * IDs come from one bitECS allocator and never collide.
 *
 * Uses anonymous agents + the unsigned in-memory transport. Core tests
 * exercise engine semantics (replication, governance, snapshot) without
 * crypto. The `@connectionengine/local` package has its own signed-transport
 * harness for tests that need real Ed25519 signatures + ZCAP capabilities.
 */

import { createManualClock, type ManualClock } from '../../src/ecs/clock'
import { initEngine } from '../../src/ecs/engine'
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
  /** Advance the clock, run one frame, flush networking, await async transport. */
  tick(deltaSeconds?: number): Promise<void>
  /** Drain any pending receives without ticking systems. */
  flush(): Promise<void>
  /** Destroy both worlds + close the link. */
  dispose(): void
}

export interface CreatePeerPairOptions {
  /** Names — also used as deterministic seeds for the anonymous agents. */
  names?: [string, string]
  /** Starting wall-clock time for both peers. */
  startTime?: number
  /** Passed straight to `connectInMemory`: latency, runtime components, and
   *  the network behaviours each side gets built with. */
  transport?: ConnectInMemoryOptions
}

export const createPeerPair = async (options: CreatePeerPairOptions = {}): Promise<PeerPair> => {
  const [nameA, nameB] = options.names ?? ['alice', 'bob']
  const start = options.startTime ?? 0
  const clock = createManualClock(start)
  initEngine({ clock })
  const worldA = createWorld({ agent: createAnonAgent(nameA) })
  const worldB = createWorld({ agent: createAnonAgent(nameB) })
  bootstrapIdentity(worldA, nameA)
  bootstrapIdentity(worldB, nameB)
  const link = await connectInMemory(worldA, worldB, options.transport)
  return {
    a: { name: nameA, world: worldA, clock },
    b: { name: nameB, world: worldB, clock },
    link,
    tick: async (deltaSeconds = 1 / 60) => {
      clock.advance(deltaSeconds * 1000)
      runSystems(deltaSeconds)
      flushAuthored(worldA)
      flushAuthored(worldB)
      flushRuntime(worldA)
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

export const createPeerMesh = async (n: number, options: CreatePeerPairOptions = {}): Promise<PeerMesh> => {
  const peers: PeerHandle[] = []
  const start = options.startTime ?? 0
  const clock = createManualClock(start)
  initEngine({ clock })
  for (let i = 0; i < n; i++) {
    const name = `peer-${i}`
    const world = createWorld({ agent: createAnonAgent(name) })
    bootstrapIdentity(world, name)
    peers.push({ name, world, clock })
  }
  const links: MemoryConnectionPair[] = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      links.push(await connectInMemory(peers[i].world, peers[j].world, options.transport))
    }
  }
  return {
    peers,
    links,
    tick: async (deltaSeconds = 1 / 60) => {
      clock.advance(deltaSeconds * 1000)
      runSystems(deltaSeconds)
      for (const p of peers) {
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
