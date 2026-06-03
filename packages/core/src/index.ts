/**
 * @connectionengine/core — public API surface.
 *
 * Organised by domain (matching the on-disk structure):
 *   schema/  — unified Schema namespace (TypeBox + SoA tags)
 *   maths/   — Vec/Quat SoA classes
 *   ecs/     — World, Entity, Components, Relations, Observers, plus clock/trace
 *   engine/  — System scheduler, Mutation pipeline, Prefab, Snapshot
 *   network/ — Identity addressing, Query, Transport, Peer, Authority,
 *              engine-level governance (credential + temporal + content)
 *
 * Core is identity- and crypto-agnostic. For Ed25519 / did:key identity + ZCAP
 * capabilities, depend on @connectionengine/local. For AD4M-backed identity,
 * transport, and persistence, depend on @connectionengine/ad4m-bridge.
 */

// ── Schema ────────────────────────────────────────────────────────────────────
export { Schema } from './schema'
export type { Static, TSchema, TObject, ArrayBufferKind, SoAStoreKind } from './schema'
export { Kind } from './schema'

// ── Maths ─────────────────────────────────────────────────────────────────────
export * from './maths/common'
export { Vec2SoA } from './maths/vec2'
export { Vec3SoA } from './maths/vec3'
export { Vec4SoA } from './maths/vec4'
export { QuatSoA } from './maths/quat'
export { Quat2SoA } from './maths/quat2'
export type { Vec2 } from './maths/vec2'
export type { Vec3 } from './maths/vec3'
export type { Vec4 } from './maths/vec4'
export type { Quat } from './maths/quat'
export type { Quat2 } from './maths/quat2'

// ── ECS ───────────────────────────────────────────────────────────────────────
export * from './ecs/world'
export * from './ecs/entity'
export * from './ecs/clock'
export * from './ecs/trace'
export * from './ecs/component'
export * from './ecs/relation'
// Observers: re-export only the unique hook constructors. The operator
// vocabulary (Or/And/Not/Any/All/None) lives in ./network/query for the
// canonical import path; observers compose them via the same names.
export { observe, onAdd, onRemove, onSet, onGet } from './ecs/observer'
export type { ObserverTerm } from './ecs/observer'

// ── Engine ────────────────────────────────────────────────────────────────────
export * from './engine/system'
export * from './engine/mutation'
export * from './engine/prefab'
export * from './engine/snapshot'

// ── Network ───────────────────────────────────────────────────────────────────
export * from './network/identity'
export * from './network/query'
export * from './network/transport'
export * from './network/peer'
export * from './network/authority'
export * from './network/governance'
