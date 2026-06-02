/**
 * Two-peer (and N-peer) test harness.
 *
 * The single most useful fixture in the codebase: stand up multiple worlds
 * with deterministic clocks + memory transport between them, drive ticks
 * synchronously, assert convergence. Almost every interesting bug in this
 * system lives at the seam between peers.
 */

import { createManualClock, type ManualClock } from '../clock'
import { keyPairFromSeed } from '../did'
import { createWorld, destroyWorld, type World } from '../world'
import { runSystems } from '../system'
import { connectInMemory, flushAsync, type MemoryConnectionPair, type MemoryTransportOptions } from '../transport'

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
  /** Memory transport options (latency, governance gate). */
  transport?: MemoryTransportOptions
  /** Names — also seed deterministic DID keypairs. */
  names?: [string, string]
  /** Starting wall-clock time for both peers. */
  startTime?: number
}

export const createPeerPair = (options: CreatePeerPairOptions = {}): PeerPair => {
  const [nameA, nameB] = options.names ?? ['alice', 'bob']
  const start = options.startTime ?? 0
  const clockA = createManualClock(start)
  const clockB = createManualClock(start)
  const worldA = createWorld({ clock: clockA, keyPair: keyPairFromSeed(nameA) })
  const worldB = createWorld({ clock: clockB, keyPair: keyPairFromSeed(nameB) })
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
  for (let i = 0; i < n; i++) {
    const name = `peer-${i}`
    const clock = createManualClock(start)
    const world = createWorld({ clock, keyPair: keyPairFromSeed(name) })
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
