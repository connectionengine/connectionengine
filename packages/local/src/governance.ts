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

export interface CapabilityValidationResult extends CoreValidationResult {}

/**
 * DIDs whose root capabilities this process accepts.
 *
 * Deployment configuration, not a per-call argument. Every peer in a session
 * must hold the same list, exactly as every peer must load the same scene: two
 * peers with different trusted issuers reach different verdicts on the same
 * event and diverge. Set it once at startup, before any session opens.
 */
let trustedIssuers: DID[] | undefined

export const setTrustedIssuers = (issuers: readonly DID[] | undefined): void => {
  trustedIssuers = issuers === undefined ? undefined : [...issuers]
}

export const getTrustedIssuers = (): readonly DID[] | undefined => trustedIssuers

registerConstraintKind({
  kind: 'capability',
  component: CapabilityConstraintComponent,
  validate({ event, data, violations }) {
    const raw = (data as { capability?: string }).capability
    if (!raw) return
    let cap: Capability
    try {
      cap = JSON.parse(raw) as Capability
    } catch {
      violations.push({ kind: 'capability', reason: 'malformed capability' })
      return
    }
    // Expiry is measured against the timestamp of the event under test, not a
    // local clock. Two peers checking the same capability a moment apart must
    // agree, and only the author's own stamp is the same on both.
    const ok =
      cap.invoker === event.author &&
      verifyCapability(cap, { now: event.timestamp, trustedIssuers }) &&
      capabilityAllows(cap, event.predicate, event.entityPath)
    if (!ok) {
      violations.push({ kind: 'capability', reason: 'capability does not authorise this predicate' })
    }
  }
})

/** Run the `validateEvent` function of core. The capability kind is already in
 *  the registry, so this runs every kind. */
export const validateLocalEvent = (world: World, event: AuthoredEvent): CapabilityValidationResult =>
  coreValidateEvent(world, event)

/**
 * Install a capability-aware governance gate on the `validateAuthored` hook of
 * the default network of a world. The `capability` kind already sits in the
 * registry of core, so `coreValidateEvent` already runs all four kinds. This
 * function only attaches it as the inbound governance hook.
 */
export const installCapabilityValidator = (world: World): void => {
  const network = ensureDefaultNetwork(world)
  network.validateAuthored = (event: AuthoredEvent) => coreValidateEvent(world, event).allowed
}
