# Connection Engine

> A spatial-semantic-sovereign runtime for the agent-centric web.

Connection Engine is a multiplayer-first, data-driven TypeScript engine for real-time spatial experiences, built on web standards. It aims to converge with [AD4M](https://github.com/coasys/ad4m) and [WE](https://github.com/coasys/we), extending their **semantic sovereign runtime** into the **spatial** dimension. The same agents, signed statements, and governance then work in 3D worlds and XR exactly as they work in documents.

See **[VISION.md](./VISION.md)** for the reasoning.

## What it is

An ECS engine in which the entity-component-relationship graph **is** a semantic graph. The graph is structurally isomorphic with RDF triples, and optimised for high framerates. Components are SHACL shapes. Relationships are predicates. Queries are SPARQL-equivalent pattern matching. Signed semantic events give every mutation cryptographic provenance.

Identity, transport, and persistence are pluggable runtime modes. The engine itself stays unopinionated:

- **Solo** — anonymous local agent, no transport. Suits fast tests and offline single-player.
- **Local** ([`@connectionengine/local`](./packages/local)) — Ed25519 / did:key identity, signed in-memory transport, ZCAP capability governance.
- **AD4M** ([`@connectionengine/ad4m-bridge`](./packages/ad4m-bridge)) — AD4M Agent identity, AD4M `PerspectiveProxy` transport, Holochain-backed persistence and replication.

You compose them per app. Same engine surface, same components, three transports.

## Packages

| Package | Role |
| --- | --- |
| [`@connectionengine/core`](./packages/core) | Pure ECS plus the distribution layer (mutation pipeline, transport, authority, governance). Identity-agnostic and crypto-agnostic. |
| [`@connectionengine/local`](./packages/local) | Solo and local-multiplayer runtime — Ed25519 DIDs, ZCAP, signed transport. |
| [`@connectionengine/ad4m-bridge`](./packages/ad4m-bridge) | AD4M-backed runtime — Agent, Ad4mClient, and PerspectiveProxy wiring. |
| [`packages/client`](./packages/client) | Reference SolidJS client. |
| [`packages/server`](./packages/server) | Reference Express server. |

## Quick start

```bash
# One-time on fresh checkout
git submodule update --init --recursive
pnpm install
pnpm --filter @coasys/ad4m build      # builds the AD4M submodule's JS SDK

# Verify
pnpm run check                         # typecheck + lint
pnpm run test                          # vitest across all packages
```

Open the interactive code graph:

```bash
pnpm --filter @connectionengine/core map:render
open .codegraph/graph.html
```

## A first taste

```ts
import {
  createEngine,
  createWorld,
  createUser,
  createPeer,
  spawnPrefab,
  defineComponent,
  setComponent,
  Schema,
  createAnonAgent
} from '@connectionengine/core'

const Health = defineComponent({
  id: 'Health',
  schema: Schema.Object({
    current: Schema.Number({ default: 100 }),
    max: Schema.Number({ default: 100 })
  })
})

const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
const user = createUser(world, { did: world.localAgent.did, asLocal: true })
createPeer(world, { user, peerId: 'tab-1', asLocal: true })

const ava = spawnPrefab(world, 'avatar:alice') // wire-addressable, owned by local user, authority on local peer
setComponent(world, ava, Health, { current: 80 })
```

`spawnPrefab` is the user-facing factory for networked entities. It composes `createEntity`, `setUID`, `OwnedBy`, and `AuthoritativeFor` in one call. The base `createEntity` is pure ECS, for the cases that need no wire identity, such as system caches and scratch entities.

Move to **local-multiplayer**, with two peers that sign their events:

```ts
import { createLocalRuntime, connectLocalInMemory } from '@connectionengine/local'

const alice = createLocalRuntime({ seed: 'alice' })
const bob = createLocalRuntime({ seed: 'bob' })
connectLocalInMemory(alice.world, bob.world)
// Anything alice's world authors is signed → delivered to bob → verified → applied.
```

Move to **distributed AD4M** when the underlying executor is available:

```ts
import { createAd4mRuntime } from '@connectionengine/ad4m-bridge'

const { world, agent, transport } = await createAd4mRuntime(ad4mClient, perspective)
// world.events flow through AD4M Perspectives — signed, replicated, persisted via Holochain.
```

## Architecture map

```
packages/
├── core/                    @connectionengine/core
│   └── src/
│       ├── schema/          TypeBox + SoA tag kinds (Vec3, Quat, ArrayBuffer, …)
│       ├── maths/           Vec/Quat SoA classes
│       ├── ecs/             Pure local runtime — Engine · World · Entity ·
│       │                    Component · Relation · Observer · Query · Identity
│       │                    (UID + BelongsTo) · System scheduler · Prefab · Clock
│       └── network/         Everything distribution-related — Mutation pipeline
│                            (queue + log + flush + apply) · Transport ·
│                            Lifecycle (handshake / replay / sweep / fanout) ·
│                            Binary delta codec · Snapshot · User / Peer ·
│                            Authority · Governance · Peers registry
│
├── local/                   @connectionengine/local
│   └── src/                 DID · ZCAP · LocalAgent · signed transport · capability governance
│
├── ad4m-bridge/             @connectionengine/ad4m-bridge
│   └── src/                 Ad4mAgent · Link encoding · PerspectiveProxy transport
│
└── ad4m/                    @coasys/ad4m (git submodule, dev branch)
```

Two layers, with nothing between them. `ecs/` is the foundation, and holds local-runtime semantics with no notion of authoring or peers. `network/` is the distribution layer, and the mutation pipeline lives there because it exists only as a consequence of distribution. oxlint enforces the split mechanically.

For day-to-day developer context, see [`AGENTS.md`](./AGENTS.md). For the broader picture, see [`VISION.md`](./VISION.md).

## Status

Three runtime modes work end to end: core solo, local two-peer with Ed25519 signing and ZCAP capability governance, and the AD4M bridge against mocks. The vitest suites pass — 197 tests in core, plus local, ad4m-bridge, and server. The code type-checks and passes lint. oxlint enforces the layering, so `ecs/` cannot depend on `network/`. Cycle detection is on.

One known problem: CI does not check out submodules or build `@coasys/ad4m`, so the `Build` step fails before the tests get a chance to run.

The spatial layer — Transform, WebXR, zones, bounding trees, and the renderer — comes next.

## License

Licensed under the **[Cryptographic Autonomy License v1.0](./LICENSE)** (CAL-1.0), the same license that [AD4M](https://github.com/coasys/ad4m) and [Holochain](https://github.com/holochain/holochain) use. CAL is a copyleft license designed for agent-centric, peer-to-peer software. It requires that anyone you give the software to also receives the autonomy, the data, and the cryptographic keys needed to use and modify it independently.

`SPDX-License-Identifier: CAL-1.0`
