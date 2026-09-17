/**
 * Governance — engine-internal enforcement of replicated constraints.
 *
 * A constraint is an ECS entity: it carries a component holding the
 * configuration, and a `HasConstraint` relation pointing at the scope it
 * guards. Constraints therefore replicate like any other data, and every peer
 * enforces them locally. There is no config channel, and no privileged peer.
 *
 * The mutation pipeline calls `validateEvent` directly. No pluggable gate
 * callback exists — the engine walks its own constraint data as an internal
 * enforcement step. A world with no constraint entities admits everything.
 *
 * Core defines three constraint kinds: `credential`, `temporal`, and
 * `content`. Their validators are stubs until there is engine content to
 * govern. `@connectionengine/local` defines the `capability` kind (ZCAP-LD)
 * through the same registry. Additional kinds compose through
 * `defineConstraint`.
 *
 * Treat `validate` as a pure function. It receives the event, the constraint
 * configuration, and the guarded scope, and nothing else. Two peers holding the
 * same replicated state must reach the same verdict, so a validator that reads
 * a local clock or asks a local oracle would let peers diverge silently. Use
 * `event.timestamp` when a rule needs a notion of "now": the author stamps it,
 * so it reads the same on every peer.
 */

import { getComponent, setComponent, type ComponentDefinition } from '../ecs/component'
import { defineComponent } from '../ecs/component'
import { Schema } from '../schema'
import { defineRelation, addRelation, getRelationTargets } from '../ecs/relation'
import { createEntity, entityExists, BelongsTo, resolveEntityPath } from '../ecs/entity'
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

// ── defineConstraint — single-call component + kind registration ────────────-

export interface DefineConstraintOptions {
  /** Stable name, as it appears on the wire. */
  kind: string
  /** Component id. Defaults to the kind name. */
  id?: string
  /** The schema that configures instances of this constraint. */
  schema: ReturnType<typeof Schema.Object>
  /** Decide whether one event satisfies one instance of this constraint, and
   *  push every violation found. */
  validate: ConstraintKindEntry['validate']
}

/**
 * Define a constraint kind: create its component and register it in one call.
 * Returns the component definition — useful for `addCapabilityConstraint`-style
 * helpers that write to the component directly.
 */
export const defineConstraint = (options: DefineConstraintOptions): ComponentDefinition => {
  const component = defineComponent({ id: options.id ?? options.kind, schema: options.schema })
  registerConstraintKind({ kind: options.kind, component, validate: options.validate })
  return component
}

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
    scope = BelongsTo.indexFor(world.engine).get(scope)
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
 * The mutation pipeline calls this directly — no pluggable gate exists.
 */
export const validateEvent = (world: World, event: AuthoredEvent): ValidationResult => {
  const entity = resolveEntityPath(world, event.entityPath) ?? world.worldRoot
  const violations: ConstraintViolation[] = []
  for (const c of resolveConstraints(world, entity)) {
    kindRegistry.get(c.kind)?.validate({ event, data: c.data, scope: c.scope, violations })
  }
  return { allowed: violations.length === 0, violations }
}

// ── Built-in constraint kinds ────────────────────────────────────────────────-
//
// Core defines three kinds. Their validators are stubs — the component shapes
// exist so that constraint entities replicate now, and enforcement logic lands
// when there is engine content to govern.

/** Require agents to hold a Verifiable Credential before performing spatial
 *  operations. Anti-bot, moderator privileges, builder access. */
export const CredentialConstraintComponent = defineConstraint({
  kind: 'credential',
  id: 'CredentialConstraint',
  schema: Schema.Object({
    requiredCredential: Schema.String({ default: '' }),
    /** Comma-separated list: 'spawn', 'modify', 'delete'. */
    operations: Schema.String({ default: 'spawn,modify,delete' })
  }),
  validate() {
    // Stub. Credential verification requires an external oracle that resolves
    // Verifiable Credentials against the event author's DID. When implemented,
    // this checks whether the author holds the named credential for the
    // operation the event performs.
  }
})

/** Rate limits on spatial operations — max spawns per minute, cooldown on
 *  authority transfers, anti-cheat position update limits. */
export const TemporalConstraintComponent = defineConstraint({
  kind: 'temporal',
  id: 'TemporalConstraint',
  schema: Schema.Object({
    minIntervalMs: Schema.Number({ default: 0 }),
    maxCountPerWindow: Schema.Number({ default: Infinity }),
    windowMs: Schema.Number({ default: 60_000 }),
    /** Comma-separated predicate list. */
    appliesTo: Schema.String({ default: '' })
  }),
  validate() {
    // Stub. Temporal rate-limiting scans the world's event log for the author's
    // recent matching mutations. When implemented, this counts events within
    // the configured window and rejects when the count or interval limit
    // exceeds the constraint.
  }
})

/** Value validation on component fields — max entity scale, allowed mesh
 *  types, blocked text content, physics mass limits. */
export const ContentConstraintComponent = defineConstraint({
  kind: 'content',
  id: 'ContentConstraint',
  schema: Schema.Object({
    /** The component predicate this constraint applies to. */
    componentType: Schema.String({ default: '' }),
    /** JSON-encoded field constraints: { field: { min?, max?, pattern?, blocklist? } }. */
    fieldConstraints: Schema.String({ default: '{}' })
  }),
  validate() {
    // Stub. Content validation compares the event's value fields against the
    // constraint's min/max/pattern/blocklist rules. When implemented, this
    // parses fieldConstraints and checks each named field of the event value.
  }
})
