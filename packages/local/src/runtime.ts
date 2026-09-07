/**
 * createLocalRuntime — a one-call setup for a world in fully local mode.
 *
 * This helper serves a solo app or a local-multiplayer app that does not want
 * to compose the agent, the engine, the world, the transport, and the
 * governance itself.
 *
 *   const { world, agent } = createLocalRuntime({ seed: 'alice' })
 *   // ... use the world. The signing and the governance are already attached.
 *
 * For a two-peer setup, link the runtimes with `connectLocalInMemory`:
 *
 *   const a = createLocalRuntime({ seed: 'alice' })
 *   const b = createLocalRuntime({ seed: 'bob' })
 *   connectLocalInMemory(a.world, b.world)
 */

import {
  createEngine,
  createWorld,
  ensureDefaultNetwork,
  type Clock,
  type Engine,
  type World
} from '@connectionengine/core'
import { createLocalAgent, type LocalAgent } from './agent'
import { installCapabilityValidator, type CapabilityValidationContext } from './governance'

export interface CreateLocalRuntimeOptions {
  /** Seed for the Ed25519 keypair of the local agent. A seed makes the keypair
   *  deterministic. */
  seed?: string
  /** An agent built earlier. It overrides `seed`. */
  agent?: LocalAgent
  /** Optional engine. It defaults to a fresh isolated engine. A local runtime
   *  usually stands alone, and one engine per runtime keeps its storage
   *  isolated from the other peers in the same process. */
  engine?: Engine
  /** Simulation tick rate of the engine. It applies only when this function
   *  constructs a fresh engine, and it is ignored when the caller supplies
   *  `engine`. It defaults to 1/60. */
  fixedTimeStep?: number
  /** Clock for the engine. It applies only to a fresh engine, and it defaults
   *  to the wall clock. */
  clock?: Clock
  /** Context for the capability validator, which holds `trustedIssuers` and the
   *  `hasCredential` oracle. Omit it to attach no governance. */
  governance?: CapabilityValidationContext | false
}

export interface LocalRuntime {
  world: World
  agent: LocalAgent
}

export const createLocalRuntime = (options: CreateLocalRuntimeOptions = {}): LocalRuntime => {
  const agent = options.agent ?? createLocalAgent({ seed: options.seed })
  const engine = options.engine ?? createEngine({ fixedTimeStep: options.fixedTimeStep, clock: options.clock })
  const world = createWorld({ engine, agent })
  // installCapabilityValidator targets the default network, so make sure that
  // network exists.
  ensureDefaultNetwork(world)
  if (options.governance !== false) {
    installCapabilityValidator(world, options.governance ?? {})
  }
  return { world, agent }
}
