/**
 * Pre-wire two worlds over an in-memory `TransportEndpoint` pair without
 * going through the formal `joinNetwork` handshake.
 *
 * Authored envelopes fan out via `installFanout`. If `runtimeComponents` are
 * supplied, a `BinaryChannel` is attached to each Connection so runtime SoA
 * deltas flow over a per-peer binary pipeline.
 *
 * Use this when you want envelope-level integration tests; use `joinNetwork`
 * for the production-shaped late-join + event-log replay path.
 *
 * The connection joins each side's `'default'` network (auto-created).
 */

import type { AuthoredEvent, Connection, World } from '../../ecs/world'
import type { ComponentDefinition } from '../../ecs/component'
import { applyAuthoredEnvelope } from '../../engine/mutation'
import { createMemoryTransport, type RuntimeTransportConfig, type TransportEndpoint } from '../transport'
import { ensureDefaultNetwork, type Network } from '../network'
import { createBinaryChannel, isBindControl, type BindControlMessage } from './binary-channel'
import { ensureChannel, installFanout, rebroadcastAuthored, setConnectionChannel } from './fanout'
import { sweepDisconnectedPeer } from './sweep'

export interface MemoryConnectionPair {
  a: Connection
  b: Connection
  close(): void
}

export interface ConnectInMemoryOptions {
  validate?: (world: World, event: AuthoredEvent) => boolean
  latencyMs?: number
  runtimeComponents?: readonly ComponentDefinition[]
  runtimeConfigs?: RuntimeTransportConfig[]
}

const isAuthoredEnvelope = (payload: unknown): payload is { fromPeer: string; events: AuthoredEvent[] } =>
  !!payload && typeof payload === 'object' && Array.isArray((payload as { events?: unknown }).events)

const wireSide = (
  world: World,
  network: Network,
  remoteDID: string,
  endpoint: TransportEndpoint,
  options: ConnectInMemoryOptions
): Connection => {
  const connection: Connection = {
    peer: 0,
    remoteDID,
    events: endpoint.events,
    stream: endpoint.stream,
    onClose: (h) => endpoint.onClose(h),
    close: () => {
      network.connections.delete(connection)
      endpoint.close()
    }
  }
  if (options.runtimeComponents && options.runtimeComponents.length > 0) {
    setConnectionChannel(
      connection,
      createBinaryChannel(world, connection, {
        components: options.runtimeComponents,
        configs: options.runtimeConfigs
      })
    )
  }
  endpoint.events.onMessage((payload) => {
    if (isBindControl(payload)) {
      ensureChannel(world, connection)?.registerBindings((payload as BindControlMessage).bindings)
      return
    }
    if (isAuthoredEnvelope(payload)) {
      applyAuthoredEnvelope(world, payload, network)
      rebroadcastAuthored(world, connection, payload)
      return
    }
  })
  endpoint.stream.onMessage((buffer) => {
    ensureChannel(world, connection)?.applyBuffer(buffer)
  })
  endpoint.onClose(() => {
    sweepDisconnectedPeer(world, connection)
    network.connections.delete(connection)
  })
  network.connections.add(connection)
  return connection
}

export const connectInMemory = (
  worldA: World,
  worldB: World,
  options: ConnectInMemoryOptions = {}
): MemoryConnectionPair => {
  const networkA = ensureDefaultNetwork(worldA)
  const networkB = ensureDefaultNetwork(worldB)
  if (options.validate) {
    const v = options.validate
    if (!networkA.validateAuthored) networkA.validateAuthored = (e) => v(worldA, e)
    if (!networkB.validateAuthored) networkB.validateAuthored = (e) => v(worldB, e)
  }
  installFanout(worldA, networkA)
  installFanout(worldB, networkB)
  const transport = createMemoryTransport({ latencyMs: options.latencyMs })
  const a = wireSide(worldA, networkA, worldB.localAgent.did, transport.a, options)
  const b = wireSide(worldB, networkB, worldA.localAgent.did, transport.b, options)
  return {
    a,
    b,
    close: () => {
      a.close()
      b.close()
      transport.close()
    }
  }
}
