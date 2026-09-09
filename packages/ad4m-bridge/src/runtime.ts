/**
 * createAd4mRuntime — a one-call setup for an AD4M-backed Connection Engine
 * world.
 *
 *   const ad4mClient = new Ad4mClient(...)
 *   const perspective = await ad4mClient.perspective.byUUID(uuid)
 *   const { world, agent, transport } = await createAd4mRuntime(ad4mClient, perspective, { engine })
 *   // ... use the world. AD4M handles the identity, the sync, and the
 *   // persistence.
 *   await transport.close() // call this at shutdown
 *
 * By default the runtime attaches no application-level governance, which means
 * anything beyond the executor-level capabilities of AD4M. Pass
 * `onValidateAuthored` to gate inbound events. The gate is fixed when the
 * network is built, so it must arrive here rather than be assigned afterwards.
 */

import type { Ad4mClient, PerspectiveProxy } from '@coasys/ad4m'
import { createWorld, type Agent, type CreateWorldOptions, type World } from '@connectionengine/core'
import { createAd4mAgent } from './agent'
import { connectAd4m, type Ad4mTransportHandle, type Ad4mTransportOptions } from './transport'

export interface Ad4mRuntime {
  world: World
  agent: Agent
  transport: Ad4mTransportHandle
}

export type CreateAd4mRuntimeOptions = Omit<CreateWorldOptions, 'agent'> & Ad4mTransportOptions

export const createAd4mRuntime = async (
  client: Ad4mClient,
  perspective: PerspectiveProxy,
  options: CreateAd4mRuntimeOptions
): Promise<Ad4mRuntime> => {
  const { onValidateAuthored, onRejected, ...worldOptions } = options
  const agent = await createAd4mAgent(client)
  const world = createWorld({ ...worldOptions, agent })
  const transport = await connectAd4m(world, perspective, { onValidateAuthored, onRejected })
  return { world, agent, transport }
}
