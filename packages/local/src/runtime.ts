/**
 * createLocalRuntime — one-call setup for a fully-local-mode world.
 *
 * Convenience helper for solo + local-multiplayer apps that don't want to
 * compose the agent / engine / world / transport / governance pieces
 * themselves.
 *
 *   const { world, agent } = createLocalRuntime({ seed: 'alice' })
 *   // ... use the world; signing + governance are wired
 *
 * For two-peer mode wire them with `connectLocalInMemory`:
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
  /** Seed for the local agent's Ed25519 keypair (deterministic if provided). */
  seed?: string
  /** Pre-built agent (overrides `seed` if supplied). */
  agent?: LocalAgent
  /** Optional engine. Defaults to a fresh isolated engine — local runtimes
   *  are typically standalone, and one engine per runtime keeps storage
   *  isolated from other peers in the same process. */
  engine?: Engine
  /** Simulation tick rate for the engine (only used when constructing a fresh
   *  engine; ignored when `engine` is supplied). Default 1/60. */
  fixedTimeStep?: number
  /** Clock for the engine (fresh-engine case only). Default wall-clock. */
  clock?: Clock
  /** Capability validator context (trustedIssuers, hasCredential oracle). Omit to skip governance wiring. */
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
  // installCapabilityValidator targets the default network; ensure it exists.
  ensureDefaultNetwork(world)
  if (options.governance !== false) {
    installCapabilityValidator(world, options.governance ?? {})
  }
  return { world, agent }
}
