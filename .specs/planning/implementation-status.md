# Connection Engine — Implementation Status

Tracks what exists in the repo vs what's been designed.

## Repo

`~/workspaces/connectionengine/connectionengine` — `github.com/connectionengine/connectionengine`

## Codebase Status: Tier 0–4 Foundations Complete

The full ECS + Network foundation laid out by the canonical exploration is implemented in `packages/core/src/`. 138 tests pass across 23 files (Vitest + in-memory two- and three-peer harness). Type-checked, lint-clean. Built on bitECS 0.4.0 + TypeBox + @noble/ed25519 + solid-js.

| Tier | Status | Files | Tests |
| --- | --- | --- | --- |
| 0 — World / Entity / DID / Clock / Trace / Schema | ✅ | `world.ts`, `entity.ts`, `did.ts`, `clock.ts`, `trace.ts`, `schema/` | 24 |
| 1 — Components / Relations / Observers | ✅ | `component.ts`, `relation.ts`, `observer.ts` | 28 |
| 2 — Identity / Query | ✅ | `identity.ts`, `query.ts` | 13 |
| 3 — Systems / Mutation pipeline / Prefabs / Snapshot / Transport | ✅ | `system.ts`, `mutation.ts`, `prefab.ts`, `snapshot.ts`, `transport.ts` | 31 |
| 4 — Peers / Authority / ZCAP / Governance | ✅ | `peer.ts`, `authority.ts`, `zcap.ts`, `governance.ts` | 34 |
| Cross-tier integration | ✅ | `integration.test.ts` | 8 |

See [`ecs-network-exploration.md`](./ecs-network-exploration.md) §9 for the canonical Implementation Dependency DAG.

## Scope notes

- Realtime transport: `transport.ts` ships the contract + an in-memory implementation suitable for tests + same-process peers. Real WebRTC / WebSocket implementations plug into the `Connection` interface — wire format compatible (JSON for authored batches; structured updates for runtime packets; binary bitECS serializers can swap in later without semantic change).
- ZCAP: minimal W3C ZCAP-LD subset — capability creation, delegation chain (with predicate / scope / expiry subset enforcement), Ed25519 chain verification. Full LD framing and the W3C action vocabulary belong to a higher integration layer.
- Governance: four constraint kinds (capability, credential, temporal, content) replicated as ECS data; `validateEvent` walks scope and evaluates. Credential checking uses an external oracle callback (`hasCredential`) — a real VC resolver / DID-Auth layer plugs in here.
- Components / relations are global definitions (one `defineComponent` per id across worlds), but storage is **per-world** (typed-array SoA + per-entity instance map allocated lazily on first set). Multiple worlds in the same process do not collide.
- Entity ids are runtime-local and never serialised; identity uses BelongsTo + UID paths (`getEntityPath` / `resolveEntityPath`) on the wire.

## Deferred to future scopes

- Spatial layer: transforms-as-spatial-relationships, WebXR spaces, zones, bounding trees, relevance policies, spatial scope handoff for authority. Begin from `physics-spatial-exploration.md`.
- Persistence / authoring: low-frequency save/load of spatial + user data. The mutation pipeline emits a SignedTriple event log per session; that same shape is the natural seed for the persistence layer.
- Production transports: WebRTC DataChannels (runtime path, unreliable unordered), WebSocket (authored path, reliable ordered), libp2p variants.
- Binary packing: bitECS native SoA / Snapshot serializers can replace the structured runtime packet format for bandwidth-sensitive deployments.
