/**
 * Governance — the mechanism for refusing an inbound event, with no policy of
 * its own.
 *
 * A constraint is an ECS entity: it carries a component holding the
 * configuration, and a `HasConstraint` relation pointing at the scope it
 * guards. Constraints therefore replicate like any other data, and every peer
 * enforces them locally. There is no config channel, and no privileged peer.
 *
 * Core defines no constraint kinds. Which writes a world admits is an
 * application question, so a kind is registered by whoever needs it —
 * `@connectionengine/local` registers ZCAP capabilities this way — and the
 * engine only walks the registry.
 *
 * Treat `validate` as a pure function. It receives the event, the constraint
 * configuration, and the guarded scope, and nothing else. Two peers holding the
 * same replicated state must reach the same verdict, so a validator that reads
 * a local clock or asks a local oracle would let peers diverge silently. Use
 * `event.timestamp` when a rule needs a notion of "now": the author stamps it,
 * so it reads the same on every peer.
 */

import { getComponent, setComponent, type ComponentDefinition } from '../ecs/component'
import { defineRelation, addRelation, getRelationTargets } from '../ecs/relation'
import { createEntity, entityExists, parentOfFor, resolveEntityPath } from '../ecs/entity'
import { query } from '../ecs/query'
import type { AuthoredEvent, Entity, World } from '../ecs/world'

/** Links a constraint entity to the scope it guards. */
export const HasConstraint = defineRelation({
  name: 'HasConstraint',
  exclusive: false
})

// ── Constraint kind registry ─────────────────────────────────────────────────-

export interface ConstraintViolation {
  kind: string
  reason: string
}

export interface ConstraintKindEntry {
  /** Stable name, as it appears on the wire. */
  kind: string
  /** The component that carries the configuration of this kind. */
  component: ComponentDefinition
  /** Decide whether one event satisfies one instance of this constraint, and
   *  push every violation found. */
  validate(args: {
    event: AuthoredEvent
    data: Record<string, unknown>
    scope: Entity
    violations: ConstraintViolation[]
  }): void
}

const kindRegistry = new Map<string, ConstraintKindEntry>()

export const registerConstraintKind = (entry: ConstraintKindEntry): void => {
  kindRegistry.set(entry.kind, entry)
}

export const getConstraintKind = (kind: string): ConstraintKindEntry | undefined => kindRegistry.get(kind)

export const listConstraintKinds = (): ConstraintKindEntry[] => Array.from(kindRegistry.values())

// ── addConstraint ─────────────────────────────────────────────────────────────

/**
 * Attach a constraint of `kind` to `scope`, configured by `config`.
 *
 * `config` is written straight onto the component of the kind, so its shape is
 * whatever that component declares.
 */
export const addConstraint = (world: World, scope: Entity, kind: string, config: Record<string, unknown>): Entity => {
  const entry = kindRegistry.get(kind)
  if (!entry) throw new Error(`addConstraint: unknown constraint kind '${kind}'`)
  const entity = createEntity(world)
  setComponent(world, entity, entry.component, config)
  addRelation(world, entity, HasConstraint, scope)
  return entity
}

// ── resolveConstraints ────────────────────────────────────────────────────────

export interface ResolvedConstraint {
  entity: Entity
  kind: string
  data: Record<string, unknown>
  scope: Entity
}

const constraintKindFor = (
  world: World,
  entity: Entity
): { kind: string; data: Record<string, unknown> } | undefined => {
  for (const entry of kindRegistry.values()) {
    const value = getComponent(world, entity, entry.component)
    if (value) return { kind: entry.kind, data: value as Record<string, unknown> }
  }
  return undefined
}

/** Enumerate the entities on this world that carry a registered constraint
 *  component. */
const constraintEntities = (world: World): Entity[] => {
  const set = new Set<Entity>()
  for (const entry of kindRegistry.values()) {
    for (const e of query(world, [entry.component])) {
      if (entityExists(world, e)) set.add(e)
    }
  }
  return Array.from(set)
}

/**
 * Walk the scope hierarchy, from the entity through each BelongsTo parent to
 * the world root. Collect every constraint that HasConstraint links to a scope
 * on that path. The result puts the most specific constraint first.
 */
export const resolveConstraints = (world: World, entity: Entity): ResolvedConstraint[] => {
  const out: ResolvedConstraint[] = []
  let scope: Entity | undefined = entity
  while (scope !== undefined) {
    for (const candidate of constraintEntities(world)) {
      const targets = getRelationTargets(world, candidate, HasConstraint)
      if (!targets.includes(scope)) continue
      const kindData = constraintKindFor(world, candidate)
      if (kindData) out.push({ entity: candidate, kind: kindData.kind, data: kindData.data, scope })
    }
    scope = parentOfFor(world.engine).get(scope)
  }
  return out
}

// ── validateEvent ─────────────────────────────────────────────────────────────

export interface ValidationResult {
  allowed: boolean
  violations: ConstraintViolation[]
}

/**
 * Validate an incoming authored event against every constraint that guards it.
 * Supply it as the `onValidateAuthored` behaviour when a network is built:
 *
 *   addNetwork(world, {
 *     id,
 *     onValidateAuthored: (world, _network, event) => validateEvent(world, event).allowed
 *   })
 */
export const validateEvent = (world: World, event: AuthoredEvent): ValidationResult => {
  const entity = resolveEntityPath(world, event.entityPath) ?? world.worldRoot
  const violations: ConstraintViolation[] = []
  for (const c of resolveConstraints(world, entity)) {
    kindRegistry.get(c.kind)?.validate({ event, data: c.data, scope: c.scope, violations })
  }
  return { allowed: violations.length === 0, violations }
}
