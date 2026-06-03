/**
 * Local agent — Ed25519/did:key Agent for solo + local-network worlds.
 *
 * Wraps a deterministic or random Ed25519 keypair into the opaque `Agent`
 * shape that core's `createWorld` requires. The `sign` hook lets the local
 * transport (or any other outbound wire) produce Ed25519 signatures over
 * canonicalised authored events.
 */

import type { Agent } from '@connectionengine/core'
import { generateKeyPair, keyPairFromSeed, sign, type KeyPair } from './did'

export interface LocalAgent extends Agent {
  /** The underlying keypair — exposed so callers can hand it to zcap delegation, etc. */
  readonly keyPair: KeyPair
}

export interface CreateLocalAgentOptions {
  /** Deterministic seed (any string). Omit for a fresh random key. */
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
