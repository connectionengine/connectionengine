/**
 * createLocalRuntime — one-call setup for a fully-local-mode world.
 *
 * Convenience helper for solo + local-multiplayer apps that don't want to
 * compose the agent / world / transport / governance pieces themselves.
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

import { createWorld, ensureDefaultNetwork, type CreateWorldOptions, type World } from '@connectionengine/core'
import { createLocalAgent, type LocalAgent } from './agent'
import { installCapabilityValidator, type CapabilityValidationContext } from './governance'

export interface CreateLocalRuntimeOptions extends Omit<CreateWorldOptions, 'agent'> {
  /** Seed for the local agent's Ed25519 keypair (deterministic if provided). */
  seed?: string
  /** Pre-built agent (overrides `seed` if supplied). */
  agent?: LocalAgent
  /** Capability validator context (trustedIssuers, hasCredential oracle). Omit to skip governance wiring. */
  governance?: CapabilityValidationContext | false
}

export interface LocalRuntime {
  world: World
  agent: LocalAgent
}

export const createLocalRuntime = (options: CreateLocalRuntimeOptions = {}): LocalRuntime => {
  const agent = options.agent ?? createLocalAgent({ seed: options.seed })
  const world = createWorld({
    agent,
    fixedTimeStep: options.fixedTimeStep,
    clock: options.clock,
    trace: options.trace
  })
  // installCapabilityValidator targets the default network; ensure it exists.
  ensureDefaultNetwork(world)
  if (options.governance !== false) {
    installCapabilityValidator(world, options.governance ?? {})
  }
  return { world, agent }
}
