/**
 * Test and development utility: link two worlds in one process through the
 * formal `joinNetwork` handshake.
 *
 * It sits in `src/` rather than under `tests/`, because
 * `@connectionengine/local` builds `connectLocalInMemory` on top of it.
 *
 * Both sides call `joinNetwork` over a paired in-memory transport. The protocol
 * is symmetric: each sends HELLO, each receives via microtask, each processes
 * (replay, snapshot) and sends handshake-complete. No deadlock, because
 * both sides drive the handshake simultaneously.
 *
 * After the returned promise resolves, both worlds have replayed each other's
 * event logs, exchanged state snapshots, and entered the live phase. Authored
 * envelopes fan across the connections through direct fan-out. Each connection
 * also gets a `BinaryChannel` for runtime SoA deltas. Pass
 * `runtimeComponents` to fix the wire order explicitly. Without it, both
 * sides derive the order from the registered continuous components.
 *
 * Governance runs engine-internally. Add constraint entities to the world
 * before connecting.
 */

import type { World } from '../ecs/world'
import type { ComponentDefinition } from '../ecs/component'
import type { Connection, RuntimeTransportConfig } from '../network/transport'
import { createMemoryTransport } from '../network/transport'
import { ensureDefaultNetwork } from '../network/network'
import { joinNetwork } from '../network/lifecycle'

export interface MemoryConnectionPair {
  a: Connection
  b: Connection
  close(): void
}

export interface ConnectInMemoryOptions {
  latencyMs?: number
  runtimeComponents?: readonly ComponentDefinition[]
  runtimeConfigs?: RuntimeTransportConfig[]
}

export const connectInMemory = async (
  worldA: World,
  worldB: World,
  options: ConnectInMemoryOptions = {}
): Promise<MemoryConnectionPair> => {
  const { latencyMs, runtimeComponents, runtimeConfigs } = options
  const transport = createMemoryTransport({ latencyMs })

  // Each side gets its own default network — pure topology, no governance.
  const networkA = ensureDefaultNetwork(worldA)
  const networkB = ensureDefaultNetwork(worldB)

  // Both sides join simultaneously. The protocol is symmetric: each sends
  // HELLO, each receives via microtask, each processes and confirms
  // readiness. No deadlock because both sides drive the handshake.
  const [resultA, resultB] = await Promise.all([
    joinNetwork(worldA, {
      endpoint: transport.a,
      network: networkA,
      runtimeComponents,
      runtimeConfigs
    }),
    joinNetwork(worldB, {
      endpoint: transport.b,
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
