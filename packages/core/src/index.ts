/**
 * @connectionengine/core — public API surface.
 *
 * Mirrors the canonical exploration doc structure
 * (`.specs/planning/ecs-network-exploration.md`):
 *   Tier 0 — World, Entity, DID
 *   Tier 1 — Components, Relations, Observers
 *   Tier 2 — Identity, Query
 *   Tier 3 — Systems, Mutation, Prefabs, Snapshots
 *   Tier 4 — Peers, Authority, Governance
 */

// ── Tier 0 ────────────────────────────────────────────────────────────────────
export * from './world'
export * from './entity'
export * from './clock'
export * from './trace'
export * from './did'

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

// ── Tier 1 ────────────────────────────────────────────────────────────────────
export * from './component'
export * from './relation'
export * from './observer'
