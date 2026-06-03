/**
 * Governance — engine-native consensus-enforced rules (core subset).
 *
 * Constraints are ECS entities, replicated as data. addConstraint creates a
 * constraint entity, attaches the appropriate ConstraintComponent, and links
 * it to the scope via HasConstraint. All peers receive it via the authored
 * pipeline and enforce it locally.
 *
 * Core ships the engine-level constraint kinds — `credential`, `temporal`,
 * `content` — that need no specific identity provider beyond an opaque DID
 * string. The `capability` (ZCAP) constraint kind lives in
 * @connectionengine/local. AD4M-backed governance lives in
 * @connectionengine/ad4m-bridge.
 *
 * `validateEvent` is suitable as the `validate` hook for `connectInMemory`
 * (or wired into `world.network.validateAuthored` by a runtime mode).
 */

import { Schema } from '../schema'
import { componentEntities, defineComponent, getComponent, setComponent } from '../ecs/component'
import { defineRelation, addRelation, getRelationTargets } from '../ecs/relation'
import { ROOT_PARENT, resolveEntityPath } from '../ecs/identity'
import { createEntity, entityExists } from '../ecs/entity'
import type { AuthoredEvent, Entity, World } from '../ecs/world'

// ── Constraint components ─────────────────────────────────────────────────────

export const CredentialConstraintComponent = defineComponent({
  id: 'CredentialConstraint',
  mutationCategory: 'authored',
  schema: Schema.Object({
    requiredCredential: Schema.String({ default: '' }),
    /** comma-separated list of ops: 'spawn,modify,delete' */
    operations: Schema.String({ default: 'spawn,modify,delete' })
  })
})

export const TemporalConstraintComponent = defineComponent({
  id: 'TemporalConstraint',
  mutationCategory: 'authored',
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
  mutationCategory: 'authored',
  schema: Schema.Object({
    componentType: Schema.String({ default: '' }),
    /** JSON-encoded { fieldName: { min?, max?, pattern?, blocklist? } } */
    fieldConstraints: Schema.String({ default: '{}' })
  })
})

export const HasConstraint = defineRelation({
  name: 'HasConstraint',
  exclusive: false,
  mutationCategory: 'authored'
})

// ── addConstraint ─────────────────────────────────────────────────────────────

export type ConstraintKind = 'credential' | 'temporal' | 'content'

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

export type ConstraintConfig = CredentialConfig | TemporalConfig | ContentConfig

export const addConstraint = (world: World, scope: Entity, kind: ConstraintKind, config: ConstraintConfig): Entity => {
  const entity = createEntity(world)
  switch (kind) {
    case 'credential': {
      const c = config as CredentialConfig
      setComponent(world, entity, CredentialConstraintComponent, {
        requiredCredential: c.requiredCredential,
        operations: (c.operations ?? ['spawn', 'modify', 'delete']).join(',')
      })
      break
    }
    case 'temporal': {
      const c = config as TemporalConfig
      setComponent(world, entity, TemporalConstraintComponent, {
        minIntervalMs: c.minIntervalMs ?? 0,
        maxCountPerWindow: c.maxCountPerWindow ?? Number.POSITIVE_INFINITY,
        windowMs: c.windowMs ?? 60_000,
        appliesTo: c.appliesTo.join(',')
      })
      break
    }
    case 'content': {
      const c = config as ContentConfig
      setComponent(world, entity, ContentConstraintComponent, {
        componentType: c.componentType,
        fieldConstraints: JSON.stringify(c.fieldConstraints)
      })
      break
    }
  }
  addRelation(world, entity, HasConstraint, scope)
  return entity
}

// ── resolveConstraints ────────────────────────────────────────────────────────

export interface ResolvedConstraint {
  entity: Entity
  kind: ConstraintKind
  data: Record<string, unknown>
  scope: Entity
}

const constraintKindFor = (
  world: World,
  entity: Entity
): { kind: ConstraintKind; data: Record<string, unknown> } | undefined => {
  const cred = getComponent(world, entity, CredentialConstraintComponent)
  if (cred) return { kind: 'credential', data: cred as Record<string, unknown> }
  const tem = getComponent(world, entity, TemporalConstraintComponent)
  if (tem) return { kind: 'temporal', data: tem as Record<string, unknown> }
  const con = getComponent(world, entity, ContentConstraintComponent)
  if (con) return { kind: 'content', data: con as Record<string, unknown> }
  return undefined
}

/**
 * Walk the scope hierarchy (entity → BelongsTo parent → ... → world root) and
 * collect every constraint linked via HasConstraint, ordered most-specific
 * first.
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

/** Enumerate entities on this world carrying any core constraint component. */
const constraintEntities = (world: World): Entity[] => {
  const set = new Set<Entity>()
  for (const e of componentEntities(world, CredentialConstraintComponent)) if (entityExists(world, e)) set.add(e)
  for (const e of componentEntities(world, TemporalConstraintComponent)) if (entityExists(world, e)) set.add(e)
  for (const e of componentEntities(world, ContentConstraintComponent)) if (entityExists(world, e)) set.add(e)
  return Array.from(set)
}

// ── validateEvent ─────────────────────────────────────────────────────────────

export interface ValidationContext {
  /** External oracle — does the author DID hold the named credential? */
  hasCredential?: (did: string, credential: string) => boolean
}

export interface ValidationResult {
  allowed: boolean
  violations: Array<{ kind: ConstraintKind; reason: string }>
}

/**
 * Validate an incoming authored event against all applicable engine-level
 * constraints. Suitable as `world.network.validateAuthored` or as the
 * `validate` option to `connectInMemory`. Runtime modes that need richer
 * constraint kinds (e.g. ZCAP capabilities) compose their own validators
 * around this one.
 */
export const validateEvent = (
  world: World,
  event: AuthoredEvent,
  context: ValidationContext = {}
): ValidationResult => {
  const entity = resolveEntityPath(world, event.entityPath) ?? ROOT_PARENT
  const constraints = resolveConstraints(world, entity)
  const violations: ValidationResult['violations'] = []

  for (const c of constraints) {
    if (c.kind === 'credential') {
      const required = (c.data as { requiredCredential: string }).requiredCredential
      const ops = (c.data as { operations: string }).operations.split(',')
      const opForEvent = event.op === 'set' ? 'modify' : event.op === 'remove' ? 'delete' : event.op
      if (ops.includes(opForEvent) && context.hasCredential && !context.hasCredential(event.author, required)) {
        violations.push({ kind: 'credential', reason: `missing credential '${required}'` })
      }
    } else if (c.kind === 'temporal') {
      const data = c.data as { minIntervalMs: number; maxCountPerWindow: number; windowMs: number; appliesTo: string }
      const predicates = data.appliesTo.split(',').filter(Boolean)
      if (predicates.length > 0 && !predicates.includes(event.predicate)) continue
      const cutoff = world.clock.now() - data.windowMs
      let count = 0
      let lastTs: number | undefined
      for (const entry of world.eventLog) {
        if (entry.author !== event.author) continue
        if (predicates.length > 0 && !predicates.includes(entry.predicate)) continue
        if (entry.timestamp < cutoff) continue
        count++
        if (lastTs === undefined || entry.timestamp > lastTs) lastTs = entry.timestamp
      }
      if (count >= data.maxCountPerWindow) {
        violations.push({
          kind: 'temporal',
          reason: `rate limit exceeded (${count}/${data.maxCountPerWindow} per ${data.windowMs}ms)`
        })
      }
      if (lastTs !== undefined && event.timestamp - lastTs < data.minIntervalMs) {
        violations.push({ kind: 'temporal', reason: `min interval ${data.minIntervalMs}ms not met` })
      }
    } else if (c.kind === 'content') {
      const data = c.data as { componentType: string; fieldConstraints: string }
      if (data.componentType !== event.predicate) continue
      let fields: Record<string, { min?: number; max?: number; pattern?: string; blocklist?: string[] }> = {}
      try {
        fields = JSON.parse(data.fieldConstraints)
      } catch {
        violations.push({ kind: 'content', reason: 'malformed field constraints' })
        continue
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
