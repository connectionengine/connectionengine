/**
 * createLocalRuntime — a one-call setup for a world in fully local mode.
 *
 * This helper serves a solo app or a local-multiplayer app that does not want
 * to compose the agent, the engine, the world, and the transport itself.
 *
 *   const { world, agent } = createLocalRuntime({ seed: 'alice' })
 *   // ... use the world. Governance runs engine-internally from constraint
 *   // entities — no pluggable gate needed.
 *
 * For a two-peer setup, link the runtimes with `connectLocalInMemory`:
 *
 *   const a = createLocalRuntime({ seed: 'alice' })
 *   const b = createLocalRuntime({ seed: 'bob' })
 *   await connectLocalInMemory(a.world, b.world)
 *
 * Signing now happens at the transport level — `connectLocalInMemory` wraps
 * each endpoint with Ed25519 signing/verification. Governance runs from the
 * constraint entities in each world — no callback to pass.
 *
 * Importing this module also imports `./governance`, which registers the
 * `capability` constraint kind with the global registry.
 */

import { createEngine, createWorld, type Clock, type Engine, type World } from '@connectionengine/core'
import { createLocalAgent, type LocalAgent } from './agent'
// Importing governance registers the capability constraint kind with the
// global registry. The import itself is the side effect.
import './governance'

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
   *  constructs a fresh engine, and gets ignored when the caller supplies
   *  `engine`. It defaults to 1/60. */
  fixedTimeStep?: number
  /** Clock for the engine. It applies only to a fresh engine, and defaults
   *  to the wall clock. */
  clock?: Clock
}

export interface LocalRuntime {
  world: World
  agent: LocalAgent
}

export const createLocalRuntime = (options: CreateLocalRuntimeOptions = {}): LocalRuntime => {
  const agent = options.agent ?? createLocalAgent({ seed: options.seed })
  const engine = options.engine ?? createEngine({ fixedTimeStep: options.fixedTimeStep, clock: options.clock })
  const world = createWorld({ engine, agent })
  return { world, agent }
}
