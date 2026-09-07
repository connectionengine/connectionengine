/**
 * @connectionengine/core — the public API surface.
 *
 * Two domain layers, which match the on-disk structure:
 *
 *   ecs/     — Engine, World, Entity, Component, Relation, Observer, Query,
 *              Identity (UID + BelongsTo), System scheduler, Prefab.
 *              A pure local runtime. It knows nothing about authoring,
 *              replication, peers, or governance.
 *
 *   network/ — Mutation pipeline (authored queue + event log + flush + apply),
 *              Transport, Lifecycle (handshake / replay / sweep / fanout),
 *              Binary delta codec, Snapshot, User / Peer, Authority,
 *              Governance, Peers registry. Everything here exists *because*
 *              state is distributed across peers.
 *
 *   schema/  — TypeBox + SoA tag kinds (Vec3, Quat, ArrayBuffer, SoAStore, …)
 *   maths/   — Vec/Quat SoA classes
 *
 * oxlint enforces the layering mechanically: `ecs/` cannot import from
 * `network/`.
 *
 * Core is identity-agnostic and crypto-agnostic. For Ed25519 or did:key
 * identity with ZCAP capabilities, depend on @connectionengine/local. For
 * AD4M-backed identity, transport, and persistence, depend on
 * @connectionengine/ad4m-bridge.
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
export * from './ecs/engine'
export * from './ecs/world'
export * from './ecs/entity'
export * from './ecs/clock'
export * from './ecs/component'
export * from './ecs/relation'
// Observers. Re-export only the unique hook constructors. The operator
// vocabulary (Or, And, Not, Any, All, None) lives in ./ecs/query, which is the
// canonical import path. Observers compose those operators under the same names.
export { observe, onAdd, onRemove, onSet, onGet } from './ecs/observer'
export type { ObserverTerm } from './ecs/observer'
export * from './ecs/query'

// ── ECS scheduling ────────────────────────────────────────────────────────────
export * from './ecs/system'

// ── Network. Everything here relates to distribution. ────────────────────────-
export * from './network/transport'
export * from './network/network'
export * from './network/mutation'
export * from './network/lifecycle/index'
export * from './network/cursor'
export * from './network/codec'
export * from './network/binary'
export * from './network/compression'
export * from './network/snapshot'
export * from './network/peer'
export * from './network/authority'
export * from './network/governance'
export * from './network/prefab'
