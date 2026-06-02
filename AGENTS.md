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

TypeScript · pnpm workspaces · bitECS v4 · TypeBox · SolidJS · Vite/Rollup · Vitest/Playwright · oxlint · Havok (physics worker via SharedArrayBuffer)

## Checks

Always ensure these pass:

```bash
pnpm run check   # type checking + linting
pnpm run test     # vitest unit tests
```

## Design docs

Canonical design document: [`.specs/planning/ecs-network-exploration.md`](./.specs/planning/ecs-network-exploration.md). Per-tier specs derived from it live in `.specs/01-..06-*.md`. Implementation status: [`.specs/planning/implementation-status.md`](./.specs/planning/implementation-status.md).
