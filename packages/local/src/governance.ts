/**
 * Capability governance — ZCAP-LD constraint kind.
 *
 * Adds a `capability` constraint to the engine-level governance set in
 * @connectionengine/core. A capability constraint requires that the event's
 * author be the invoker of a valid (signed, unexpired, in-scope) ZCAP that
 * authorises the predicate for the event's entity path.
 *
 * Wired into a world via `installCapabilityValidator(world, options)`, which
 * composes with core's `validateEvent` so all four constraint kinds
 * (credential + temporal + content + capability) are enforced.
 */

import type { AuthoredEvent, Entity, World } from '@connectionengine/core'
import {
  Schema,
  componentEntities,
  defineComponent,
  entityExists,
  getComponent,
  HasConstraint,
  ROOT_PARENT,
  addRelation,
  createEntity,
  getRelationTargets,
  resolveEntityPath,
  setComponent,
  validateEvent as coreValidateEvent,
  type ValidationContext as CoreValidationContext,
  type ValidationResult as CoreValidationResult
} from '@connectionengine/core'
import type { DID } from './did'
import { type Capability, capabilityAllows, verifyCapability } from './zcap'

// ── Capability constraint component ──────────────────────────────────────────-

export const CapabilityConstraintComponent = defineComponent({
  id: 'CapabilityConstraint',
  mutationCategory: 'authored',
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

// ── Validation ────────────────────────────────────────────────────────────────

export interface CapabilityValidationContext extends CoreValidationContext {
  /** Trusted root capability issuers. */
  trustedIssuers?: DID[]
}

export interface CapabilityValidationResult extends CoreValidationResult {}

const capabilityScopes = (world: World, entity: Entity): Entity[] => {
  const out: Entity[] = []
  let scope: Entity | undefined = entity
  while (scope !== undefined) {
    out.push(scope)
    scope = world.parentOf.get(scope)
  }
  return out
}

/**
 * Validate an event against all attached capability constraints (walking the
 * BelongsTo scope hierarchy), composed with core's engine-level governance.
 */
export const validateLocalEvent = (
  world: World,
  event: AuthoredEvent,
  context: CapabilityValidationContext = {}
): CapabilityValidationResult => {
  // Core constraints first
  const core = coreValidateEvent(world, event, context)
  const violations = [...core.violations]

  // Then capability constraints
  const entity = resolveEntityPath(world, event.entityPath) ?? ROOT_PARENT
  const scopes = new Set(capabilityScopes(world, entity))
  for (const candidate of componentEntities(world, CapabilityConstraintComponent)) {
    if (!entityExists(world, candidate)) continue
    const targets = getRelationTargets(world, candidate, HasConstraint)
    if (!targets.some((t) => scopes.has(t))) continue
    const raw = getComponent(world, candidate, CapabilityConstraintComponent) as { capability: string } | undefined
    if (!raw?.capability) continue
    let cap: Capability
    try {
      cap = JSON.parse(raw.capability) as Capability
    } catch {
      violations.push({ kind: 'capability' as never, reason: 'malformed capability' })
      continue
    }
    const ok =
      cap.invoker === event.author &&
      verifyCapability(cap, { now: world.clock.now(), trustedIssuers: context.trustedIssuers }) &&
      capabilityAllows(cap, event.predicate, event.entityPath)
    if (!ok) {
      violations.push({ kind: 'capability' as never, reason: 'capability does not authorise this predicate' })
    }
  }

  const allowed = violations.length === 0
  if (allowed && core.allowed) {
    // already traced by coreValidateEvent
  } else if (!allowed && violations.length > core.violations.length) {
    world.trace.emit({
      kind: 'governance.reject',
      ts: world.clock.now(),
      predicate: event.predicate,
      detail: { violations }
    })
  }
  return { allowed, violations }
}

/**
 * Install a capability-aware governance gate on a world's
 * `network.validateAuthored`. Composes with core's engine-level governance.
 */
export const installCapabilityValidator = (world: World, context: CapabilityValidationContext = {}): void => {
  world.network.validateAuthored = (event) => validateLocalEvent(world, event, context).allowed
}
