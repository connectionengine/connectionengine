# Connection Engine

A semantic spatial web engine — multiplayer-first, data-driven TypeScript runtime for real-time spatial experiences. Built on web standards (WebGPU, WebRTC, WebXR, Web Crypto), designed to converge with AD4M/WE as the spatial runtime for the decentralised semantic web.

## What it is

An ECS engine where the entity-component-relationship graph **is** a semantic graph — structurally isomorphic with RDF triples, optimised for 60fps. Components are SHACL shapes. Relationships are predicates. Queries are SPARQL-equivalent pattern matching. Mutations carry cryptographic provenance via DID-signed triples.

## Core design

- **Everything is an entity.** Users, avatars, scores, quests, factions, inventories — only engine runtime bindings (timer, WebXR, WebGPU, resource loaders, input) live outside the ECS.
- **Component-level mutation categories.** Authored (reliable, governance-validated, event-sourced) vs runtime (binary, authority-checked, ephemeral) vs local (never replicated).
- **Agent-centric networking.** No inherent server — each peer evaluates shared governance rules locally. A dedicated server is just a peer with broader authority.
- **Schema-driven.** A single TypeBox schema definition generates SoA stores, instance stores, JSON Schema, SHACL shapes, and governance hooks.

## Tech stack

TypeScript · pnpm workspaces · bitECS v4 · TypeBox · SolidJS · @noble/ed25519 · Vite/Rollup · Vitest/Playwright · oxlint · Havok (physics worker via SharedArrayBuffer)

## Engine surface (`@connectionengine/core`)

Tier-by-tier API. All wired through `packages/core/src/index.ts`:

- **Tier 0** — `createWorld`, `destroyWorld`, `tickWorld`, `createEntity`, `removeEntity`, `Schema.*` (TypeBox + SoA Vec3/Quat/Float32/…), `generateKeyPair`, `signTriple`, `verifyTriple`, `createManualClock`, `createTraceSink`.
- **Tier 1** — `defineComponent({ id, schema, mutationCategory? })`, `setComponent`, `getComponent`, `removeComponent`, `defineRelation`, `addRelation`, `removeRelation`, `observe`, `onAdd`/`onRemove`/`onSet`/`onGet`.
- **Tier 2** — `UIDComponent`, `BelongsTo`, `setUID`, `getEntityByUID`, `getEntityPath`, `resolveEntityPath`, `query`, `Or`/`And`/`Not`/`Hierarchy`/`Cascade`.
- **Tier 3** — `defineSystem({ phase, execute?, reactor? })`, `runSystems`, `flushAuthored`/`flushRuntime`, `receivePayload`, `connectInMemory`, `definePrefab`, `instantiatePrefab`, `createSnapshot`, `applySnapshot`.
- **Tier 4** — `createUser`, `createPeer`, `OwnedBy`/`AuthoritativeFor`, `requestAuthority`, `transferAuthority`, `recoverAuthority`, `createRootCapability`, `delegateCapability`, `verifyCapability`, `addConstraint`, `resolveConstraints`, `validateEvent`.
- **Testing** — `createPeerPair`, `createPeerMesh` (deterministic clocks + seeded DIDs + in-memory transport).

## Checks

Always ensure these pass:

```bash
pnpm run check   # type checking + linting
pnpm run test     # vitest unit tests
```

## Code map

The core package wraps [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph) (Tree-sitter under the hood — 79 files / 704 nodes / 1.8k edges in this repo) for cross-package code intelligence.

```bash
pnpm --filter @connectionengine/core map   # sync index + print status
```

The graph lives at `.codegraph/codegraph.db` (gitignored, ~1.6 MB). After running `map` once, raw queries work from the repo root:

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
