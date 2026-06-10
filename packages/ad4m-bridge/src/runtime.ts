/**
 * createAd4mRuntime — one-call wiring for an AD4M-backed Connection Engine world.
 *
 *   const ad4mClient = new Ad4mClient(...)
 *   const perspective = await ad4mClient.perspective.byUUID(uuid)
 *   const { world, agent, transport } = await createAd4mRuntime(ad4mClient, perspective)
 *   // ... use world; AD4M handles identity + sync + persistence
 *   await transport.close() // on shutdown
 *
 * Application-level governance (beyond AD4M's executor-level capabilities) is
 * not wired here — compose your own `world.network.validateAuthored` after
 * createAd4mRuntime returns.
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
