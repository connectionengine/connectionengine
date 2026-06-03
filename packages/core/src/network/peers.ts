/**
 * Peer transport registry — engine-level deduplication of physical transports.
 *
 * Many networks per world, many worlds per engine. The same remote peer may
 * appear on multiple of them. The registry ensures only one underlying
 * physical transport (RTCPeerConnection / QUIC connection / WebSocket /
 * in-memory pair) exists per remote DID per engine; each Network requests it
 * and opens its own channel pair on top.
 *
 * Lives in the network layer (uses TransportEndpoint) but is engine-keyed:
 * stamped into `engine.customRegistries` under a private symbol so `ecs/`
 * stays oblivious.
 */

import type { Engine } from '../ecs/engine'
import { getOrCreateRegistry } from '../ecs/engine'
import type { TransportEndpoint } from './transport'

export interface PeerHandle {
  readonly endpoint: TransportEndpoint
  /** Refcount-managed release. Closes the underlying transport when the last network releases. */
  release(): void
}

export interface PeerTransportRegistry {
  /**
   * Acquire (or create) a transport for the given remote DID. The factory
   * runs only on first acquisition; subsequent calls return the existing
   * endpoint and increment a refcount.
   */
  acquire(remoteDID: string, factory: () => TransportEndpoint): PeerHandle
  /** Snapshot of currently-held DIDs. Debug / inspection only. */
  knownDIDs(): string[]
}

interface Entry {
  endpoint: TransportEndpoint
  refs: number
}

const PEER_REGISTRY_KEY = Symbol('connectionengine.peers')

const createRegistry = (): PeerTransportRegistry => {
  const byDID = new Map<string, Entry>()
  return {
    acquire(remoteDID, factory) {
      let entry = byDID.get(remoteDID)
      if (!entry) {
        entry = { endpoint: factory(), refs: 0 }
        byDID.set(remoteDID, entry)
      }
      entry.refs++
      return {
        endpoint: entry.endpoint,
        release: () => {
          if (!entry) return
          entry.refs--
          if (entry.refs <= 0) {
            byDID.delete(remoteDID)
            entry.endpoint.close()
          }
        }
      }
    },
    knownDIDs: () => Array.from(byDID.keys())
  }
}

/** Get-or-create the peer transport registry for an engine. */
export const getPeerRegistry = (engine: Engine): PeerTransportRegistry =>
  getOrCreateRegistry(engine, PEER_REGISTRY_KEY, createRegistry)
