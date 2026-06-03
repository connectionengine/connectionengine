/**
 * Governance — engine-native consensus-enforced rules (core subset).
 *
 * Constraints are ECS entities, replicated as data. `addConstraint` creates
 * an entity, attaches the appropriate ConstraintComponent, and links it to
 * a scope via `HasConstraint`. All peers receive the constraint via the
 * authored pipeline and enforce it locally.
 *
 * Constraint kinds are a registry — `registerConstraintKind` adds a new kind.
 * Core ships three kinds (`credential`, `temporal`, `content`); other packages
 * (e.g. `@connectionengine/local`'s ZCAP capability constraint) compose by
 * registering their own kinds at module load. `validateEvent` walks the
 * registry rather than a hardcoded switch — adding a kind requires no edit
 * to validateEvent.
 */

import { Schema } from '../schema'
import {
  componentEntities,
  defineComponent,
  getComponent,
  setComponent,
  type ComponentDefinition
} from '../ecs/component'
import { defineRelation, addRelation, getRelationTargets } from '../ecs/relation'
import { resolveEntityPath } from '../ecs/identity'
import { createEntity, entityExists } from '../ecs/entity'
import type { AuthoredEvent, Entity, World } from '../ecs/world'

// ── Constraint components ─────────────────────────────────────────────────────

export const CredentialConstraintComponent = defineComponent({
  id: 'CredentialConstraint',
  schema: Schema.Object({
    requiredCredential: Schema.String({ default: '' }),
    /** comma-separated list of ops: 'spawn,modify,delete' */
    operations: Schema.String({ default: 'spawn,modify,delete' })
  })
})

export const TemporalConstraintComponent = defineComponent({
  id: 'TemporalConstraint',
  schema: Schema.Object({
    minIntervalMs: Schema.Number({ default: 0 }),
    maxCountPerWindow: Schema.Number({ default: Number.POSITIVE_INFINITY }),
    windowMs: Schema.Number({ default: 60_000 }),
    /** comma-separated predicate ids this rate-limits */
    appliesTo: Schema.String({ default: '' })
  })
})

export const ContentConstraintComponent = defineComponent({
  id: 'ContentConstraint',
  schema: Schema.Object({
    componentType: Schema.String({ default: '' }),
    /** JSON-encoded { fieldName: { min?, max?, pattern?, blocklist? } } */
    fieldConstraints: Schema.String({ default: '{}' })
  })
})

export const HasConstraint = defineRelation({
  name: 'HasConstraint',
  exclusive: false
})

// ── Constraint kind registry ─────────────────────────────────────────────────-

export interface ValidationContext {
  /** External oracle — does the author DID hold the named credential? */
  hasCredential?: (did: string, credential: string) => boolean
}

export interface ConstraintViolation {
  kind: string
  reason: string
}

export interface ConstraintKindEntry {
  /** Stable name on the wire + in trace. */
  kind: string
  /** The component carrying this kind's data. */
  component: ComponentDefinition
  /**
   * Validate one event against one resolved instance of this constraint kind.
   * Push any violations. Use `world.eventLog` + `world.clock` for stateful
   * rules (temporal, rate-limits). The constraint scope is provided in case
   * a kind cares about it (e.g. ownership-scoped rules).
   */
  validate(args: {
    world: World
    event: AuthoredEvent
    data: Record<string, unknown>
    scope: Entity
    context: ValidationContext
    violations: ConstraintViolation[]
  }): void
}

const kindRegistry = new Map<string, ConstraintKindEntry>()
const kindByComponentId = new Map<string, ConstraintKindEntry>()

export const registerConstraintKind = (entry: ConstraintKindEntry): void => {
  if (kindRegistry.has(entry.kind)) {
    throw new Error(`registerConstraintKind: kind '${entry.kind}' already registered`)
  }
  kindRegistry.set(entry.kind, entry)
  kindByComponentId.set(entry.component.$id, entry)
}

export const getConstraintKind = (kind: string): ConstraintKindEntry | undefined => kindRegistry.get(kind)

export const listConstraintKinds = (): ConstraintKindEntry[] => Array.from(kindRegistry.values())

// ── Built-in kinds: credential / temporal / content ──────────────────────────-

registerConstraintKind({
  kind: 'credential',
  component: CredentialConstraintComponent,
  validate({ event, data, context, violations }) {
    const required = data.requiredCredential as string
    const ops = (data.operations as string).split(',')
    const opForEvent = event.op === 'set' ? 'modify' : event.op === 'remove' ? 'delete' : event.op
    if (!ops.includes(opForEvent)) return
    if (context.hasCredential && !context.hasCredential(event.author, required)) {
      violations.push({ kind: 'credential', reason: `missing credential '${required}'` })
    }
  }
})

registerConstraintKind({
  kind: 'temporal',
  component: TemporalConstraintComponent,
  validate({ world, event, data, violations }) {
    const cfg = data as { minIntervalMs: number; maxCountPerWindow: number; windowMs: number; appliesTo: string }
    const predicates = cfg.appliesTo.split(',').filter(Boolean)
    if (predicates.length > 0 && !predicates.includes(event.predicate)) return
    const cutoff = world.clock.now() - cfg.windowMs
    let count = 0
    let lastTs: number | undefined
    for (const entry of world.eventLog) {
      if (entry.author !== event.author) continue
      if (predicates.length > 0 && !predicates.includes(entry.predicate)) continue
      if (entry.timestamp < cutoff) continue
      count++
      if (lastTs === undefined || entry.timestamp > lastTs) lastTs = entry.timestamp
    }
    if (count >= cfg.maxCountPerWindow) {
      violations.push({
        kind: 'temporal',
        reason: `rate limit exceeded (${count}/${cfg.maxCountPerWindow} per ${cfg.windowMs}ms)`
      })
    }
    if (lastTs !== undefined && event.timestamp - lastTs < cfg.minIntervalMs) {
      violations.push({ kind: 'temporal', reason: `min interval ${cfg.minIntervalMs}ms not met` })
    }
  }
})

registerConstraintKind({
  kind: 'content',
  component: ContentConstraintComponent,
  validate({ event, data, violations }) {
    const cfg = data as { componentType: string; fieldConstraints: string }
    if (cfg.componentType !== event.predicate) return
    let fields: Record<string, { min?: number; max?: number; pattern?: string; blocklist?: string[] }> = {}
    try {
      fields = JSON.parse(cfg.fieldConstraints)
    } catch {
      violations.push({ kind: 'content', reason: 'malformed field constraints' })
      return
    }
    const value = (event.value ?? {}) as Record<string, unknown>
    for (const [field, rule] of Object.entries(fields)) {
      const v = value[field]
      if (typeof v === 'number') {
        if (rule.min !== undefined && v < rule.min)
          violations.push({ kind: 'content', reason: `${field} < ${rule.min}` })
        if (rule.max !== undefined && v > rule.max)
          violations.push({ kind: 'content', reason: `${field} > ${rule.max}` })
      }
      if (typeof v === 'string') {
        if (rule.pattern && !new RegExp(rule.pattern).test(v))
          violations.push({ kind: 'content', reason: `${field} fails pattern` })
        if (rule.blocklist?.some((b) => v.includes(b)))
          violations.push({ kind: 'content', reason: `${field} contains blocked content` })
      }
    }
  }
})

// ── addConstraint ─────────────────────────────────────────────────────────────

export type ConstraintKindName = 'credential' | 'temporal' | 'content' | (string & {})

export interface CredentialConfig {
  requiredCredential: string
  operations?: Array<'spawn' | 'modify' | 'delete'>
}
export interface TemporalConfig {
  minIntervalMs?: number
  maxCountPerWindow?: number
  windowMs?: number
  appliesTo: string[]
}
export interface ContentConfig {
  componentType: string
  fieldConstraints: Record<
    string,
    {
      min?: number
      max?: number
      pattern?: string
      blocklist?: string[]
    }
  >
}

export type ConstraintConfig = CredentialConfig | TemporalConfig | ContentConfig | Record<string, unknown>

export const addConstraint = (
  world: World,
  scope: Entity,
  kind: ConstraintKindName,
  config: ConstraintConfig
): Entity => {
  const entry = kindRegistry.get(kind)
  if (!entry) throw new Error(`addConstraint: unknown constraint kind '${kind}'`)
  const entity = createEntity(world)
  setComponent(world, entity, entry.component, normaliseConfig(kind, config) as Record<string, unknown>)
  addRelation(world, entity, HasConstraint, scope)
  return entity
}

const normaliseConfig = (kind: string, config: ConstraintConfig): Record<string, unknown> => {
  switch (kind) {
    case 'credential': {
      const c = config as CredentialConfig
      return {
        requiredCredential: c.requiredCredential,
        operations: (c.operations ?? ['spawn', 'modify', 'delete']).join(',')
      }
    }
    case 'temporal': {
      const c = config as TemporalConfig
      return {
        minIntervalMs: c.minIntervalMs ?? 0,
        maxCountPerWindow: c.maxCountPerWindow ?? Number.POSITIVE_INFINITY,
        windowMs: c.windowMs ?? 60_000,
        appliesTo: c.appliesTo.join(',')
      }
    }
    case 'content': {
      const c = config as ContentConfig
      return {
        componentType: c.componentType,
        fieldConstraints: JSON.stringify(c.fieldConstraints)
      }
    }
    default:
      return config as Record<string, unknown>
  }
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

/**
 * Walk the scope hierarchy (entity → BelongsTo parent → ... → world root) and
 * collect every constraint linked via HasConstraint, ordered most-specific first.
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
    scope = world.parentOf.get(scope)
  }
  return out
}

/** Enumerate entities on this world carrying any registered constraint component. */
const constraintEntities = (world: World): Entity[] => {
  const set = new Set<Entity>()
  for (const entry of kindRegistry.values()) {
    for (const e of componentEntities(world, entry.component)) {
      if (entityExists(world, e)) set.add(e)
    }
  }
  return Array.from(set)
}

// ── validateEvent ─────────────────────────────────────────────────────────────

export interface ValidationResult {
  allowed: boolean
  violations: ConstraintViolation[]
}

/**
 * Validate an incoming authored event against every applicable constraint —
 * walks the entity's scope chain, looks up each constraint's kind in the
 * registry, calls the kind's `validate` function. Suitable as
 * `network.validateAuthored` or as the `validate` option to
 * `connectInMemory`.
 */
export const validateEvent = (
  world: World,
  event: AuthoredEvent,
  context: ValidationContext = {}
): ValidationResult => {
  const entity = resolveEntityPath(world, event.entityPath) ?? world.worldRoot
  const constraints = resolveConstraints(world, entity)
  const violations: ConstraintViolation[] = []
  for (const c of constraints) {
    const entry = kindRegistry.get(c.kind)
    if (!entry) continue
    entry.validate({ world, event, data: c.data, scope: c.scope, context, violations })
  }
  const allowed = violations.length === 0
  if (allowed) world.trace.emit({ kind: 'governance.accept', ts: world.clock.now(), predicate: event.predicate })
  else
    world.trace.emit({
      kind: 'governance.reject',
      ts: world.clock.now(),
      predicate: event.predicate,
      detail: { violations }
    })
  return { allowed, violations }
}
