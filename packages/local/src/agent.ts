/**
 * Local agent — an Ed25519 and did:key Agent, for a solo world or a
 * local-network world.
 *
 * It wraps a deterministic or random Ed25519 keypair into the opaque `Agent`
 * shape that `createWorld` in core requires. The `sign` hook lets the local
 * transport, or any other outbound wire, produce an Ed25519 signature over a
 * canonicalised authored event.
 */

import type { Agent } from '@connectionengine/core'
import { generateKeyPair, keyPairFromSeed, sign, type KeyPair } from './did'

export interface LocalAgent extends Agent {
  /** The underlying keypair. It stays public, so that a caller can give it to a
   *  ZCAP delegation or to a similar operation. */
  readonly keyPair: KeyPair
}

export interface CreateLocalAgentOptions {
  /** Deterministic seed, as any string. Omit it to get a fresh random key. */
  seed?: string
}

export const createLocalAgent = (options: CreateLocalAgentOptions = {}): LocalAgent => {
  const keyPair = options.seed ? keyPairFromSeed(options.seed) : generateKeyPair()
  return {
    did: keyPair.did,
    sign: (bytes) => sign(bytes, keyPair.privateKey),
    keyPair
  }
}
