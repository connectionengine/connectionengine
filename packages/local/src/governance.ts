/**
 * Capability governance — ZCAP-LD constraint kind.
 *
 * Registers a `capability` kind with core's constraint registry. Once
 * registered, core's `validateEvent` enforces ZCAP capabilities alongside
 * the engine-level kinds (credential, temporal, content). No separate
 * validator is needed — `installCapabilityValidator` just wires
 * `core.validateEvent` (with optional trusted-issuer context) into
 * `world.network.validateAuthored`.
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
    /** Serialised capability JSON (parsed during validation). */
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
  /** Trusted root capability issuers. */
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

/** Run core's validateEvent with capability context attached. */
export const validateLocalEvent = (
  world: World,
  event: AuthoredEvent,
  context: CapabilityValidationContext = {}
): CapabilityValidationResult => coreValidateEvent(world, event, context)

/**
 * Install a capability-aware governance gate on a world's
 * `network.validateAuthored`. Since the `capability` kind is registered with
 * core's registry, `coreValidateEvent` already runs all four kinds — this
 * just wires it as the inbound governance hook.
 */
export const installCapabilityValidator = (world: World, context: CapabilityValidationContext = {}): void => {
  const network = ensureDefaultNetwork(world)
  network.validateAuthored = (event: AuthoredEvent) => coreValidateEvent(world, event, context).allowed
}
