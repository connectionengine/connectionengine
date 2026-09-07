/**
 * Capability governance — the ZCAP-LD constraint kind.
 *
 * This module registers a `capability` kind with the constraint registry of
 * core. After that registration, the `validateEvent` function of core enforces
 * the ZCAP capabilities beside the engine-level kinds: credential, temporal,
 * and content. No separate validator is needed. `installCapabilityValidator`
 * only attaches `core.validateEvent`, with an optional trusted-issuer context,
 * to the `validateAuthored` gate of the default network of the world.
 */

import type { AuthoredEvent, World } from '@connectionengine/core'
import {
  Schema,
  addRelation,
  createEntity,
  defineComponent,
  ensureDefaultNetwork,
  HasConstraint,
  registerConstraintKind,
  setComponent,
  validateEvent as coreValidateEvent,
  type Entity,
  type ValidationContext as CoreValidationContext,
  type ValidationResult as CoreValidationResult
} from '@connectionengine/core'
import type { DID } from './did'
import { type Capability, capabilityAllows, verifyCapability } from './zcap'

// ── Capability constraint component ──────────────────────────────────────────-

export const CapabilityConstraintComponent = defineComponent({
  id: 'CapabilityConstraint',
  schema: Schema.Object({
    /** Serialised capability JSON. Validation parses it. */
    capability: Schema.String({ default: '' })
  })
})

export const addCapabilityConstraint = (world: World, scope: Entity, capability: Capability): Entity => {
  const entity = createEntity(world)
  setComponent(world, entity, CapabilityConstraintComponent, {
    capability: JSON.stringify(capability)
  })
  addRelation(world, entity, HasConstraint, scope)
  return entity
}

// ── Validation kind: capability ──────────────────────────────────────────────-

export interface CapabilityValidationContext extends CoreValidationContext {
  /** The trusted issuers of a root capability. */
  trustedIssuers?: DID[]
}

export interface CapabilityValidationResult extends CoreValidationResult {}

registerConstraintKind({
  kind: 'capability',
  component: CapabilityConstraintComponent,
  validate({ world, event, data, context, violations }) {
    const raw = (data as { capability?: string }).capability
    if (!raw) return
    let cap: Capability
    try {
      cap = JSON.parse(raw) as Capability
    } catch {
      violations.push({ kind: 'capability', reason: 'malformed capability' })
      return
    }
    const trustedIssuers = (context as CapabilityValidationContext).trustedIssuers
    const ok =
      cap.invoker === event.author &&
      verifyCapability(cap, { now: world.engine.clock.now(), trustedIssuers }) &&
      capabilityAllows(cap, event.predicate, event.entityPath)
    if (!ok) {
      violations.push({ kind: 'capability', reason: 'capability does not authorise this predicate' })
    }
  }
})

/** Run the `validateEvent` function of core, with the capability context
 *  attached. */
export const validateLocalEvent = (
  world: World,
  event: AuthoredEvent,
  context: CapabilityValidationContext = {}
): CapabilityValidationResult => coreValidateEvent(world, event, context)

/**
 * Install a capability-aware governance gate on the `validateAuthored` hook of
 * the default network of a world. The `capability` kind already sits in the
 * registry of core, so `coreValidateEvent` already runs all four kinds. This
 * function only attaches it as the inbound governance hook.
 */
export const installCapabilityValidator = (world: World, context: CapabilityValidationContext = {}): void => {
  const network = ensureDefaultNetwork(world)
  network.validateAuthored = (event: AuthoredEvent) => coreValidateEvent(world, event, context).allowed
}
