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
| [`@connectionengine/core`](./packages/core) | Pure ECS + engine + identity-agnostic network primitives. No crypto, no AD4M. |
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
import { createWorld, defineComponent, setComponent, Schema, createAnonAgent } from '@connectionengine/core'

const Health = defineComponent({
  id: 'Health',
  schema: Schema.Object({
    current: Schema.Number({ default: 100 }),
    max: Schema.Number({ default: 100 })
  })
})

const world = createWorld({ agent: createAnonAgent() })
const e = world.createEntity()
setComponent(world, e, Health, { current: 80 })
```

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
│       ├── schema/          unified Schema namespace (TypeBox + SoA tags)
│       ├── maths/           Vec/Quat SoA classes
│       ├── ecs/             World · Entity · Component · Relation · Observer · clock · trace
│       ├── engine/          System scheduler · Mutation pipeline · Prefab · Snapshot
│       └── network/         Identity · Query · Transport · Peer · Authority · Governance
│
├── local/                   @connectionengine/local
│   └── src/                 DID · ZCAP · LocalAgent · signed transport · capability governance
│
├── ad4m-bridge/             @connectionengine/ad4m-bridge
│   └── src/                 Ad4mAgent · Link encoding · PerspectiveProxy transport
│
└── ad4m/                    @coasys/ad4m (git submodule, dev branch)
```

For the canonical engine design, see [`.specs/planning/ecs-network-exploration.md`](./.specs/planning/ecs-network-exploration.md). For day-to-day developer context, see [`AGENTS.md`](./AGENTS.md). For the broader picture, see [`VISION.md`](./VISION.md).

## Status

Three runtime modes work end-to-end (core solo, local two-peer with signing + ZCAP, AD4M bridge against mocks). 148 tests passing. Type-checked + lint-clean. Layering enforced by oxlint (`ecs/` cannot depend on `engine/` or `network/`). Cycle detection on.

The spatial layer (Transform, WebXR, zones, bounding trees, renderer) is the next major work — see [`.specs/planning/physics-spatial-exploration.md`](./.specs/planning/physics-spatial-exploration.md).

## License

Licensed under the **[Cryptographic Autonomy License v1.0](./LICENSE)** (CAL-1.0) — the same license as [AD4M](https://github.com/coasys/ad4m) and [Holochain](https://github.com/holochain/holochain). CAL is a copyleft license designed for agent-centric, peer-to-peer software: it requires that anyone you give the software to also gets the autonomy, data, and cryptographic keys needed to use and modify it independently.

`SPDX-License-Identifier: CAL-1.0`
