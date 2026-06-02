/**
 * Mutation pipeline — flush + apply.
 *
 * Two paths share one schema:
 *   AUTHORED — reliable, governance-validated, event-sourced. Local writes
 *              enqueue { entity, predicate, op, value } in world.authoredQueue
 *              (see component.ts / relation.ts). flushAuthored resolves
 *              entity paths, signs as Triples, broadcasts to all connections,
 *              appends to the canonical event log.
 *   RUNTIME  — binary, authority-checked. Local writes set dirty flags;
 *              flushRuntime drains, samples SoA stores, packs per-field
 *              snapshots, broadcasts.
 *
 * Receive: validate (if governance hook supplied), then apply with
 * origin='network' (suppresses re-broadcast).
 *
 * Maps to canonical doc §3.13 (Realtime Transport & Mutation Pipeline).
 */

import type { Entity, World } from './world'
import type { ComponentDefinition } from './component'
import { getComponentById, getSoA, hasComponent, removeComponent, setComponent } from './component'
import type { RelationDefinition } from './relation'
import { addRelation, getRelationByName, removeRelation } from './relation'
import { ROOT_PARENT, getEntityByUID, getEntityPath, resolveEntityPath, setUID } from './identity'
import { createEntity, removeEntity } from './entity'
import { signTriple, verifyTriple, type SignedTriple } from './did'

// ── Component / relation registries (per-world, keyed by id/name) ─────────────

const componentDefs = new WeakMap<World, Map<string, ComponentDefinition>>()
const relationDefs = new WeakMap<World, Map<string, RelationDefinition<unknown>>>()

export const registerComponentForPipeline = (world: World, component: ComponentDefinition): void => {
  let map = componentDefs.get(world)
  if (!map) {
    map = new Map()
    componentDefs.set(world, map)
  }
  map.set(component.id, component)
}

export const registerRelationForPipeline = (world: World, relation: RelationDefinition<unknown>): void => {
  let map = relationDefs.get(world)
  if (!map) {
    map = new Map()
    relationDefs.set(world, map)
  }
  map.set(relation.name, relation)
}

// Wire the register hooks so any component/relation used on a world is
// resolvable by the pipeline's receive path.
import { registerComponentRegisterHook } from './component'
import { registerRelationRegisterHook } from './relation'
registerComponentRegisterHook(registerComponentForPipeline)
registerRelationRegisterHook(registerRelationForPipeline)

/**
 * Resolve a component definition for a given id. Falls back to the global
 * definition registry so receivers can apply triples for components that exist
 * in the schema (anywhere) but haven't been touched on this world yet.
 */
const findComponent = (world: World, id: string): ComponentDefinition | undefined =>
  componentDefs.get(world)?.get(id) ?? getComponentById(id)

const findRelation = (world: World, name: string): RelationDefinition<unknown> | undefined =>
  relationDefs.get(world)?.get(name) ?? getRelationByName(name)

/** Iterate every component registered against a world (for snapshot/walks). */
export const worldComponents = (world: World): ComponentDefinition[] =>
  Array.from(componentDefs.get(world)?.values() ?? [])

/** Iterate every relation registered against a world. */
export const worldRelations = (world: World): RelationDefinition<unknown>[] =>
  Array.from(relationDefs.get(world)?.values() ?? [])

// ── Wire payload shapes ───────────────────────────────────────────────────────

export interface AuthoredBatch {
  kind: 'authored'
  fromPeer: string
  triples: SignedTriple[]
}

export interface RuntimePacket {
  kind: 'runtime'
  fromPeer: string
  updates: Array<{
    predicate: string
    entityPath: string[]
    soa: Record<string, number | number[]>
  }>
}

export type TransportPayload = AuthoredBatch | RuntimePacket

// ── Flush ─────────────────────────────────────────────────────────────────────

/**
 * Drain authored queue, resolve paths, sign triples, broadcast to all peers,
 * append to event log. Call at end of tick.
 */
export const flushAuthored = (world: World): AuthoredBatch | undefined => {
  if (world.authoredQueue.length === 0) return undefined
  const triples: SignedTriple[] = []
  const now = world.clock.now()
  for (const queued of world.authoredQueue) {
    if (queued.origin !== 'local') continue
    const path = getEntityPath(world, queued.entity)
    if (path.length === 0) continue // anonymous entity — not addressable on the wire
    // For relation triples we need the target's path too
    let value: unknown = queued.value
    if (value && typeof value === 'object' && 'target' in value) {
      const targetPath = getEntityPath(world, (value as { target: Entity }).target)
      if (targetPath.length === 0) continue
      value = { targetPath }
    }
    const triple = signTriple(
      { entityPath: path, predicate: queued.predicate, value, op: queued.op },
      world.network.localKeyPair,
      now
    )
    triples.push(triple)
    world.eventLog.push(triple)
    world.trace.emit({
      kind: 'mutation.emit',
      ts: now,
      origin: 'local',
      predicate: queued.predicate,
      entity: queued.entity,
      peer: world.network.localKeyPair.did
    })
  }
  world.authoredQueue.length = 0
  if (triples.length === 0) return undefined
  const batch: AuthoredBatch = { kind: 'authored', fromPeer: world.network.localKeyPair.did, triples }
  broadcast(world, batch)
  return batch
}

/**
 * Drain runtime dirty set, sample SoA stores, broadcast.
 */
export const flushRuntime = (world: World): RuntimePacket | undefined => {
  if (world.runtimeDirty.size === 0) return undefined
  const updates: RuntimePacket['updates'] = []
  for (const [componentId, entities] of world.runtimeDirty) {
    if (entities.size === 0) continue
    const def = findComponent(world, componentId)
    if (!def || def.mutationCategory !== 'runtime') {
      entities.clear()
      continue
    }
    for (const entity of entities) {
      const path = getEntityPath(world, entity)
      if (path.length === 0) continue
      const defSoA = getSoA(world, def)
      const soa: Record<string, number | number[]> = {}
      for (const field of def.$soaFields) {
        const store = defSoA[field] as { to?: (entity: number) => unknown } & Record<number, number>
        if (typeof store.to === 'function') soa[field] = store.to(entity) as number | number[]
        else soa[field] = store[entity]
      }
      updates.push({ predicate: componentId, entityPath: path, soa })
    }
    entities.clear()
  }
  if (updates.length === 0) return undefined
  const packet: RuntimePacket = { kind: 'runtime', fromPeer: world.network.localKeyPair.did, updates }
  broadcast(world, packet)
  return packet
}

const broadcast = (world: World, payload: TransportPayload): void => {
  for (const conn of world.network.connections) conn.send(payload)
  world.trace.emit({
    kind: 'transport.send',
    ts: world.clock.now(),
    peer: world.network.localKeyPair.did,
    detail: { kind: payload.kind, count: payload.kind === 'authored' ? payload.triples.length : payload.updates.length }
  })
}

// ── Receive + apply ───────────────────────────────────────────────────────────

export interface ReceiveOptions {
  /** Governance gate. Return false to reject. Tier 4 governance.ts wires this in. */
  validate?: (world: World, triple: SignedTriple) => boolean
}

export const receivePayload = (world: World, payload: TransportPayload, options: ReceiveOptions = {}): void => {
  world.trace.emit({
    kind: 'transport.receive',
    ts: world.clock.now(),
    peer: payload.fromPeer,
    detail: { kind: payload.kind }
  })
  if (payload.kind === 'authored') receiveAuthored(world, payload, options)
  else receiveRuntime(world, payload)
}

const receiveAuthored = (world: World, batch: AuthoredBatch, options: ReceiveOptions): void => {
  for (const triple of batch.triples) {
    if (!verifyTriple(triple)) {
      world.trace.emit({
        kind: 'mutation.reject',
        ts: world.clock.now(),
        predicate: triple.predicate,
        detail: { reason: 'invalid signature' }
      })
      continue
    }
    if (options.validate && !options.validate(world, triple)) {
      world.trace.emit({
        kind: 'mutation.reject',
        ts: world.clock.now(),
        predicate: triple.predicate,
        detail: { reason: 'governance' }
      })
      continue
    }
    applyTriple(world, triple)
    world.eventLog.push(triple)
    world.trace.emit({
      kind: 'mutation.receive',
      ts: world.clock.now(),
      origin: 'network',
      predicate: triple.predicate,
      detail: { author: triple.authorDID }
    })
  }
}

const applyTriple = (world: World, triple: SignedTriple): void => {
  let entity = resolveEntityPath(world, triple.entityPath)

  if (triple.op === 'destroy') {
    if (entity !== undefined) removeEntity(world, entity)
    return
  }

  if (entity === undefined) {
    entity = ensureEntityPath(world, triple.entityPath)
  }

  // Component triple
  const component = findComponent(world, triple.predicate)
  if (component) {
    if (triple.op === 'set') {
      setComponent(world, entity, component, (triple.value ?? {}) as Record<string, unknown>, { origin: 'network' })
    } else if (triple.op === 'remove') {
      removeComponent(world, entity, component, { origin: 'network' })
    }
    return
  }

  // Relation triple — value carries the target entity path
  const relation = findRelation(world, triple.predicate)
  if (relation) {
    const targetPath = (triple.value as { targetPath?: string[] } | null)?.targetPath
    if (!targetPath) return
    const target = ensureEntityPath(world, targetPath)
    if (triple.op === 'set') addRelation(world, entity, relation, target, { origin: 'network' })
    else if (triple.op === 'remove') removeRelation(world, entity, relation, target, { origin: 'network' })
  }
}

const ensureEntityPath = (world: World, path: string[]): Entity => {
  let parent: Entity = ROOT_PARENT
  let cursor: Entity = ROOT_PARENT
  for (const uid of path) {
    const existing = getEntityByUID(world, parent, uid)
    if (existing !== undefined) {
      cursor = existing
    } else {
      cursor = createEntity(world, { silent: true })
      if (parent === ROOT_PARENT) setUID(world, cursor, uid, { origin: 'network' })
      else setUID(world, cursor, uid, { parent, origin: 'network' })
    }
    parent = cursor
  }
  return cursor
}

const receiveRuntime = (world: World, packet: RuntimePacket): void => {
  for (const update of packet.updates) {
    const component = findComponent(world, update.predicate)
    if (!component || component.mutationCategory !== 'runtime') continue
    let entity = resolveEntityPath(world, update.entityPath)
    if (entity === undefined) entity = ensureEntityPath(world, update.entityPath)
    if (!hasComponent(world, entity, component)) {
      setComponent(world, entity, component, update.soa as Record<string, unknown>, { origin: 'network' })
    } else {
      // Direct SoA write — bypass setComponent so we don't re-mark dirty
      const componentSoA = getSoA(world, component)
      for (const [field, value] of Object.entries(update.soa)) {
        const store = componentSoA[field] as
          | { from?: (entity: number, data: unknown) => void; resize?: (n: number) => void }
          | undefined
        if (!store) continue
        if (typeof store.resize === 'function') store.resize(entity + 1)
        if (typeof store.from === 'function') store.from(entity, value)
        else (store as unknown as { [k: number]: number })[entity] = value as number
      }
      world.trace.emit({
        kind: 'mutation.receive',
        ts: world.clock.now(),
        origin: 'network',
        predicate: update.predicate,
        entity
      })
    }
  }
}
