# Connection Engine

A semantic spatial web engine — multiplayer-first, data-driven TypeScript runtime for real-time spatial experiences. Built on web standards (WebGPU, WebRTC, WebXR, Web Crypto), designed to converge with AD4M/WE as the spatial runtime for the decentralised semantic web.

## What it is

An ECS engine where the entity-component-relationship graph **is** a semantic graph — structurally isomorphic with RDF triples, optimised for 60fps. Components are SHACL shapes. Relationships are predicates. Queries are SPARQL-equivalent pattern matching. The core engine is identity- and crypto-agnostic; identity, transport, and persistence are pluggable runtime modes.

## Architecture

Three packages, three responsibilities:

| Package | Role |
| --- | --- |
| **`@connectionengine/core`** | Pure ECS + spatial runtime. World, Entity, Components, Relations, Observers, Query, Identity addressing (BelongsTo + UID), System scheduler, Mutation pipeline (unsigned `AuthoredEvent`), Prefab, Snapshot, in-memory transport, engine-level governance (credential + temporal + content). No identity provider, no signing, no transport-specific code. |
| **`@connectionengine/local`** | Solo/local-multiplayer runtime. Ed25519/did:key identity, ZCAP-LD capability constraints, signed in-memory transport. `createLocalRuntime({ seed })` wires it all together. Self-contained — no external dependencies on Holochain/AD4M. |
| **`@connectionengine/ad4m-bridge`** | AD4M-backed runtime. Wraps AD4M `Agent` (identity + signing), `Ad4mClient` (RPC), and `PerspectiveProxy` (Link/LinkExpression replication via Holochain). `createAd4mRuntime({ client, perspective })` plugs Connection Engine onto the AD4M executor. The AD4M repo is a git submodule at `packages/ad4m/` — see `## AD4M submodule` below. |

Core works standalone for tests + solo apps. Layer `local/` on top for full cryptographic guarantees without AD4M. Layer `ad4m-bridge/` on top for decentralised persistence + sync + identity via AD4M / Holochain.

## Core design

- **Everything is an entity.** Users, avatars, scores, quests, factions, inventories — only engine runtime bindings (timer, WebXR, WebGPU, resource loaders, input) live outside the ECS.
- **Component-level mutation categories.** Authored (reliable, governance-validated, event-sourced) vs runtime (binary, authority-checked, ephemeral) vs local (never replicated).
- **Agent-centric networking.** No inherent server — each peer evaluates shared governance rules locally. A dedicated server is just a peer with broader authority.
- **Schema-driven.** A single TypeBox schema definition generates SoA stores, instance stores, JSON Schema, SHACL shapes, and governance hooks.

## Tech stack

TypeScript · pnpm workspaces · bitECS v4 · TypeBox · SolidJS · Vite/Rollup · Vitest/Playwright · oxlint · Havok (physics worker via SharedArrayBuffer)

**Runtime modes:**

- `local/` adds `@noble/ed25519` + `@noble/hashes`
- `ad4m-bridge/` adds `@coasys/ad4m` (via submodule)

## Core surface (`@connectionengine/core`)

Organised by domain (matching the on-disk structure):

- **`schema/`** — unified `Schema` namespace: `Schema.Object`, `Schema.Number`, `Schema.Vec3`, `Schema.Quat`, `Schema.Float32`, … TypeBox-backed with SoA tag kinds.
- **`maths/`** — `Vec2SoA`, `Vec3SoA`, `Vec4SoA`, `QuatSoA`, `Quat2SoA`, `resizableArray`.
- **`ecs/`** — `createWorld({ agent, ... })`, `destroyWorld`, `tickWorld`, `createAnonAgent`, `createEntity`, `removeEntity`, `defineComponent`, `setComponent` / `getComponent` / `removeComponent`, `defineRelation`, `addRelation` / `removeRelation`, `observe` + `onAdd`/`onRemove`/`onSet`/`onGet`, `createManualClock`, `createTraceSink`. **No crypto.**
- **`engine/`** — `defineSystem({ phase, execute?, reactor? })`, `runSystems`, `flushAuthored` / `flushRuntime` (produce unsigned envelopes via `world.network.publishAuthored?`), `applyAuthoredEnvelope` / `applyRuntimeEnvelope` (consume verified envelopes from a runtime mode), `definePrefab`, `instantiatePrefab`, `createSnapshot`, `applySnapshot`.
- **`network/`** — `UIDComponent`, `BelongsTo`, `setUID`, `getEntityByUID`, `getEntityPath`, `resolveEntityPath`, `query`, `Or`/`And`/`Not`/`Hierarchy`/`Cascade`, `connectInMemory` (unsigned), `createUser`, `createPeer`, `OwnedBy` / `AuthoritativeFor`, `requestAuthority` / `transferAuthority` / `recoverAuthority`, `addConstraint` / `validateEvent` (engine-level constraints only: credential, temporal, content).

`AuthoredEvent` is the engine's wire-agnostic mutation shape: `{ entityPath, predicate, op, value, author, timestamp }`. Runtime modes wrap it for signing/transport.

## Local runtime surface (`@connectionengine/local`)

- `createLocalAgent({ seed? })` — Ed25519 keypair wrapped as an opaque `Agent`.
- `createLocalRuntime({ seed?, agent?, governance? })` — convenience: world + agent + capability validator.
- `connectLocalInMemory(worldA, worldB)` — signed in-memory transport (Ed25519-signed envelopes).
- `createRootCapability` / `delegateCapability` / `verifyCapability` / `capabilityAllows` — ZCAP-LD.
- `addCapabilityConstraint(world, scope, cap)` + `installCapabilityValidator(world, ctx)` — capability governance composed with core's engine-level governance.

## AD4M bridge surface (`@connectionengine/ad4m-bridge`)

Imports directly from `@coasys/ad4m` — `Ad4mClient`, `PerspectiveProxy`, `Link`, `LinkExpression`, `ExpressionProof`. Consumers who don't want AD4M simply don't depend on this package; `@connectionengine/core` and `@connectionengine/local` never reference AD4M.

- `createAd4mAgent(client: Ad4mClient)` — wraps AD4M's logged-in agent into the opaque `Agent` core wants.
- `eventToLink` / `linkExpressionToEvent` — AuthoredEvent ↔ AD4M Link encoding (v0: single Link per event).
- `connectAd4m(world, perspective)` — installs `publishAuthored` (→ `perspective.addLinks`) + `link-added` listener (→ `applyAuthoredEnvelope`).
- `createAd4mRuntime(client, perspective)` — world + agent + transport in one call.

## Checks

Always ensure these pass:

```bash
pnpm run check   # type checking + oxlint (including layering rules)
pnpm run test    # vitest across all packages
```

The lint config enforces:

- `ecs/**` cannot import from `engine/**` or `network/**` (foundation-layer protection)
- `import/no-cycle` across all source files (cycle gate, depth 10)
- The AD4M submodule (`packages/ad4m/**`) is ignored by oxlint and the layering rules.

## AD4M submodule

The AD4M monorepo is checked out as a git submodule at `packages/ad4m`, tracking the `dev` branch. `pnpm-workspace.yaml` includes only `packages/ad4m/core` (the JS SDK) — the rest of AD4M (Rust executor, languages, CLI) is built independently via AD4M's own pnpm-workspace.

**One-time setup on a fresh checkout:**

```bash
git submodule update --init --recursive
pnpm install
pnpm --filter @coasys/ad4m build   # produces packages/ad4m/core/lib/
```

The AD4M build step is required because `@coasys/ad4m`'s `main`/`module`/`types` point at `lib/...`. Without it, the bridge package cannot resolve `@coasys/ad4m` imports.

**Updating to the latest AD4M `dev`:**

```bash
git submodule update --remote packages/ad4m
pnpm --filter @coasys/ad4m build
git add packages/ad4m && git commit -m "bump ad4m submodule"
```

The submodule SHA is pinned in our commit so every checkout is reproducible.

**Consumers without AD4M:** apps that don't need AD4M never add `@connectionengine/ad4m-bridge` to their deps. The bridge is the only package that depends on `@coasys/ad4m`, so AD4M's transitive deps (Holochain client, base64-js, pako) are required only when you opt in.

## Code map

The core package wraps [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph) (Tree-sitter under the hood) for cross-package code intelligence.

```bash
pnpm --filter @connectionengine/core map         # sync index + print status
pnpm --filter @connectionengine/core map:render  # also emit visualisations
```

`map:render` produces three artifacts under `.codegraph/` (all gitignored):

- **`graph.md`** — Mermaid module-level dependency graph of `packages/core/src/`, grouped into `ecs/`/`engine/`/`network/` subgraphs.
- **`graph.html`** — interactive Cytoscape view of all symbols + their `calls`/`references` edges. Search, kind filters, click-to-inspect.
- **`graph.json`** — raw `{nodes, edges}` payload for downstream tooling.

The script (`packages/core/scripts/map-render.ts`) reads `.codegraph/codegraph.db` directly via `node:sqlite` (Node 22+). No npm deps.

After running `map` once, raw codegraph subcommands work from the repo root:

```bash
npx codegraph query "<symbol>"             # search by name
npx codegraph callers "<symbol>"           # who calls this?
npx codegraph callees "<symbol>"           # what does this call?
npx codegraph impact  "<symbol>"           # full blast radius of a change
npx codegraph context "<task description>" # markdown context bundle for an AI agent
npx codegraph serve                        # MCP server for editor / agent integration
```

## Design docs

Canonical design document: [`.specs/planning/ecs-network-exploration.md`](./.specs/planning/ecs-network-exploration.md). Per-tier specs derived from it live in `.specs/01-..06-*.md`. Implementation status: [`.specs/planning/implementation-status.md`](./.specs/planning/implementation-status.md).
