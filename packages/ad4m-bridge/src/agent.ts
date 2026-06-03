/**
 * AD4M Agent → Connection Engine Agent.
 *
 * Wraps the logged-in agent of an `Ad4mClient` into the opaque `Agent` shape
 * that core's `createWorld` requires. Signing is delegated to the AD4M agent's
 * own keypair via `agent.signMessage`.
 */

import type { Ad4mClient } from '@coasys/ad4m'
import type { Agent } from '@connectionengine/core'

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

const fromHex = (hex: string): Uint8Array => {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

export const createAd4mAgent = async (client: Ad4mClient): Promise<Agent> => {
  const me = await client.agent.me()
  return {
    did: me.did,
    sign: async (bytes) => fromHex(await client.agent.signMessage(toHex(bytes)))
  }
}
