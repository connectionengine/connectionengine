# Connection Engine — Implementation Status

Tracks what exists in the repo vs what's been designed.

## Repo

`~/workspaces/connectionengine/connectionengine` — `github.com/connectionengine/connectionengine`

## Packages

| Package | Role | Status |
| --- | --- | --- |
| **`@connectionengine/core`** | Pure ECS + engine + identity-agnostic network primitives | ✅ |
| **`@connectionengine/local`** | Solo / local-multiplayer runtime — Ed25519 DIDs, ZCAP capabilities, signed in-memory transport | ✅ |
| **`@connectionengine/ad4m-bridge`** | AD4M-backed runtime — Agent / Ad4mClient / PerspectiveProxy wiring | ✅ (wiring only — needs running AD4M executor for end-to-end) |

## Core (`packages/core/src/`) — domain layout

| Domain | Responsibilities | Tests |
| --- | --- | --- |
| `schema/` | Unified `Schema` namespace (TypeBox + SoA tag kinds) | 5 |
| `maths/` | Vec/Quat SoA classes + resizable typed-array helper | 5 |
| `ecs/` | World, Entity, clock, trace, Component, Relation, Observer | 49 |
| `engine/` | System scheduler, Mutation pipeline (no crypto), Prefab, Snapshot | 31 |
| `network/` | Identity (BelongsTo+UID), Query, in-memory transport, Peer, Authority, engine-level governance | 28 |
| Cross-domain integration | Two-peer + three-peer convergence scenarios | 8 |

Total: 118 tests in core. Type-checked, lint-clean (oxlint).

## Local (`packages/local/src/`)

- DID (Ed25519 / did:key encoding)
- ZCAP (capability chain + signed delegation + verification)
- `createLocalAgent` (opaque Agent wrapping a keypair)
- `connectLocalInMemory` (signed in-memory transport — sign on send, verify on receive)
- `addCapabilityConstraint` + `installCapabilityValidator` (capability governance composed with core's engine-level governance)
- `createLocalRuntime` (one-call convenience)

22 tests (8 DID + 9 ZCAP + 5 runtime).

## AD4M bridge (`packages/ad4m-bridge/src/`)

- `createAd4mAgent` — wraps Ad4mClient agent into an opaque Agent
- `eventToLink` / `linkExpressionToEvent` — AuthoredEvent ↔ AD4M Link/LinkExpression encoding (v0)
- `connectAd4m` — installs `publishAuthored` (→ `perspective.addLinks`) + `link-added` listener (→ `applyAuthoredEnvelope`)
- `createAd4mRuntime` — one-call wiring

8 unit tests with mock Ad4mClient / PerspectiveProxy. End-to-end against a running AD4M instance is a separate test surface (requires Holochain executor).

The AD4M repo lives as a git submodule at `packages/ad4m/` tracking the `dev` branch. `pnpm-workspace.yaml` includes only `packages/ad4m/core` (the JS SDK); the rest of AD4M's monorepo (Rust executor, languages, CLI) is managed by its own pnpm-workspace.

See [`ecs-network-exploration.md`](./ecs-network-exploration.md) §9 for the canonical Implementation Dependency DAG.

## Scope notes

- The engine is **identity- and crypto-agnostic** at the core layer. `world.network.localAgent` is an opaque `{ did: string; sign?(bytes) }` interface. The mutation pipeline produces unsigned `AuthoredEvent`s; signing and wire format are the runtime mode's concern.
- Three runtime modes are supported and freely composable:
  - **Solo**: `createWorld({ agent: createAnonAgent() })` — no transport, no signatures, useful for tests and offline apps.
  - **Local**: `createLocalRuntime({ seed })` + `connectLocalInMemory` — Ed25519 signing on the wire, ZCAP capability governance.
  - **AD4M**: `createAd4mRuntime({ client, perspective })` — full distributed identity, signing, sync, persistence via AD4M / Holochain.
- ZCAP: minimal W3C ZCAP-LD subset — capability creation, delegation chain (predicate / scope / expiry subset enforcement), Ed25519 chain verification. Lives in `@connectionengine/local`. Full LD framing and the W3C action vocabulary belong to a higher integration layer.
- Engine-level governance constraints (`@connectionengine/core/network/governance.ts`): three kinds — `credential`, `temporal`, `content` — replicated as ECS data; `validateEvent` walks the scope hierarchy and evaluates. Capability constraints live in `@connectionengine/local`. AD4M-native governance uses AD4M's own executor-level capability system.
- Components and relations are global definitions (one `defineComponent` per id across worlds), but storage is **per-world** (typed-array SoA + per-entity instance map allocated lazily on first set). Multiple worlds in the same process do not collide.
- Entity ids are runtime-local and never serialised; identity uses BelongsTo + UID paths (`getEntityPath` / `resolveEntityPath`) on the wire.
- Layering enforced via oxlint `no-restricted-imports`: `ecs/` cannot import from `engine/` or `network/`. Cycle detection enabled (`import/no-cycle`, depth 10).

## Deferred to future scopes

- Spatial layer: transforms-as-spatial-relationships, WebXR spaces, zones, bounding trees, relevance policies, spatial scope handoff for authority. Begin from `physics-spatial-exploration.md`.
- Persistence / authoring: low-frequency save/load of spatial + user data. The mutation pipeline emits an `AuthoredEvent` log per session; that same shape is the natural seed for persistence layers (or hands off to AD4M Perspectives directly).
- Production transports: WebRTC DataChannels (runtime path, unreliable unordered), WebSocket (authored path, reliable ordered), libp2p variants — slot into the `Connection` interface or replace `publishAuthored` / `publishRuntime` per the bridge pattern.
- Binary packing: bitECS native SoA / Snapshot serializers can replace the structured runtime packet format for bandwidth-sensitive deployments.
- AD4M end-to-end testing: requires a running Holochain executor; bridge unit tests cover wiring, e2e tests need separate infra.
