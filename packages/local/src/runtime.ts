/**
 * createLocalRuntime — a one-call setup for a world in fully local mode.
 *
 * This helper serves a solo app or a local-multiplayer app that does not want
 * to compose the agent, the engine, the world, and the transport itself.
 *
 *   const { world, agent } = createLocalRuntime({ seed: 'alice' })
 *
 * For a two-peer setup, link the runtimes with `connectLocalInMemory`:
 *
 *   const a = createLocalRuntime({ seed: 'alice' })
 *   const b = createLocalRuntime({ seed: 'bob' })
 *   await connectLocalInMemory(a.world, b.world)
 *
 * Importing this module also imports `./governance`, which registers the
 * `capability` constraint kind with the global registry.
 */

import { initEngine, createWorld, type World } from '@connectionengine/core'
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
}

export interface LocalRuntime {
  world: World
  agent: LocalAgent
}

export const createLocalRuntime = (options: CreateLocalRuntimeOptions = {}): LocalRuntime => {
  const agent = options.agent ?? createLocalAgent({ seed: options.seed })
  initEngine()
  const world = createWorld({ agent })
  return { world, agent }
}
