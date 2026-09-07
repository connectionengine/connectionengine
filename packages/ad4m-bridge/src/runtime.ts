/**
 * createAd4mRuntime — a one-call setup for an AD4M-backed Connection Engine
 * world.
 *
 *   const ad4mClient = new Ad4mClient(...)
 *   const perspective = await ad4mClient.perspective.byUUID(uuid)
 *   const { world, agent, transport } = await createAd4mRuntime(ad4mClient, perspective)
 *   // ... use the world. AD4M handles the identity, the sync, and the
 *   // persistence.
 *   await transport.close() // call this at shutdown
 *
 * This function attaches no application-level governance, which means anything
 * beyond the executor-level capabilities of AD4M. Set the `validateAuthored`
 * gate of your own network after `createAd4mRuntime` returns. Reach that
 * network with `ensureDefaultNetwork(world)`.
 */

import type { Ad4mClient, PerspectiveProxy } from '@coasys/ad4m'
import { createWorld, type Agent, type CreateWorldOptions, type World } from '@connectionengine/core'
import { createAd4mAgent } from './agent'
import { connectAd4m, type Ad4mTransportHandle } from './transport'

export interface Ad4mRuntime {
  world: World
  agent: Agent
  transport: Ad4mTransportHandle
}

export const createAd4mRuntime = async (
  client: Ad4mClient,
  perspective: PerspectiveProxy,
  options: Omit<CreateWorldOptions, 'agent'>
): Promise<Ad4mRuntime> => {
  const agent = await createAd4mAgent(client)
  const world = createWorld({ ...options, agent })
  const transport = await connectAd4m(world, perspective)
  return { world, agent, transport }
}
