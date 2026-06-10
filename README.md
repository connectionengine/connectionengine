# Connection Engine

> A spatial-semantic-sovereign runtime for the agent-centric web.

Connection Engine is a multiplayer-first, data-driven TypeScript engine for real-time spatial experiences. Built on web standards. Designed to converge with [AD4M](https://github.com/coasys/ad4m) / [WE](https://github.com/coasys/we) — extending their **semantic sovereign runtime** with the **spatial** dimension so the same agents, signed statements, and governance work in 3D worlds and XR as they do in documents.

See **[VISION.md](./VISION.md)** for the why.

## What it is

An ECS engine where the entity-component-relationship graph **is** a semantic graph — structurally isomorphic with RDF triples, optimised for high framerates. Components are SHACL shapes. Relationships are predicates. Queries are SPARQL-equivalent pattern matching. Mutations carry cryptographic provenance via signed semantic events.

Identity, transport, and persistence are pluggable runtime modes — the engine itself is unopinionated:

- **Solo** — anonymous local agent, no transport. Fast tests, offline single-player.
- **Local** ([`@connectionengine/local`](./packages/local)) — Ed25519 / did:key identity, signed in-memory transport, ZCAP capability governance.
- **AD4M** ([`@connectionengine/ad4m-bridge`](./packages/ad4m-bridge)) — AD4M Agent identity, AD4M `PerspectiveProxy` transport, Holochain-backed persistence + replication.

You compose them per app. Same engine surface, same components, three transports.

## Packages

| Package | Role |
| --- | --- |
| [`@connectionengine/core`](./packages/core) | Pure ECS + the distribution layer (mutation pipeline, transport, authority, governance). Identity- and crypto-agnostic. |
| [`@connectionengine/local`](./packages/local) | Solo / local-multiplayer runtime — Ed25519 DIDs, ZCAP, signed transport. |
| [`@connectionengine/ad4m-bridge`](./packages/ad4m-bridge) | AD4M-backed runtime — Agent / Ad4mClient / PerspectiveProxy wiring. |
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

`spawnPrefab` is the user-facing factory for networked entities — it composes `createEntity + setUID + OwnedBy + AuthoritativeFor` in one call. The base `createEntity` is pure ECS for cases that don't need a wire identity (system caches, scratch entities).

Promote to **local-multiplayer** with two peers signing their events:

```ts
import { createLocalRuntime, connectLocalInMemory } from '@connectionengine/local'

const alice = createLocalRuntime({ seed: 'alice' })
const bob = createLocalRuntime({ seed: 'bob' })
connectLocalInMemory(alice.world, bob.world)
// Anything alice's world authors is signed → delivered to bob → verified → applied.
```

Promote to **distributed AD4M** when the underlying executor is available:

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

Two layers, no middle — `ecs/` is the foundation (local-runtime semantics, no notion of authoring or peers); `network/` is the distribution layer (the mutation pipeline only exists because state is distributed). The split is enforced mechanically by oxlint.

For day-to-day developer context, see [`AGENTS.md`](./AGENTS.md). For the broader picture, see [`VISION.md`](./VISION.md).

## Status

Three runtime modes work end-to-end (core solo, local two-peer with Ed25519 signing + ZCAP capability governance, AD4M bridge against mocks). 203 unit/integration tests + 2 Playwright tests pass across all packages. Type-checked + lint-clean. Layering enforced by oxlint (`ecs/` cannot depend on `network/`). Cycle detection on.

The spatial layer (Transform, WebXR, zones, bounding trees, renderer) is the next major work.

## License

Licensed under the **[Cryptographic Autonomy License v1.0](./LICENSE)** (CAL-1.0) — the same license as [AD4M](https://github.com/coasys/ad4m) and [Holochain](https://github.com/holochain/holochain). CAL is a copyleft license designed for agent-centric, peer-to-peer software: it requires that anyone you give the software to also gets the autonomy, data, and cryptographic keys needed to use and modify it independently.

`SPDX-License-Identifier: CAL-1.0`
