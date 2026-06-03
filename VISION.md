# Connection Engine — Vision

## The short version

**Connection Engine is the 3D analogue of [WE](https://github.com/coasys/we) — and one day it ships with it.**

WE + AD4M is the **semantic sovereign runtime**: agent-centric, peer-to-peer, where every meaningful piece of data is a signed semantic statement and every user is a cryptographic agent rather than a row in someone's database. Today WE delivers that runtime through 2D web surfaces — documents, links, perspectives, tools.

Connection Engine adds the **spatial** dimension. Same agents, same signed semantic statements, same governance — but the surface is real-time multiplayer 3D, suitable for collaborative virtual worlds, XR environments, spatial knowledge gardens, and games. The combined result is a **spatial semantic sovereign runtime** — the full surface of computing, decentralised, on web standards, with cryptographic provenance baked into every change of state.

## Why?

The web was built around documents. The spatial web — VR, AR, multiplayer 3D — is still being built around closed platforms (Roblox, Unity Cloud, Meta Horizon). Each one is an enclosure. Each one owns your identity, your data, your social graph, your creations. Each one extracts rent from the relationships you build inside it.

The agent-centric, peer-to-peer alternative now exists for the document web: Holochain, AD4M, WE. What's missing is the same alternative for the spatial web — an engine where you bring your own agent, your own perspectives, your own governance, into any 3D experience, and your creations remain yours.

Connection Engine is that engine.

(Note: "agent" refers to a cryptographic identity that can sign statements and delegate authority, not necessarily an AI. An agent could be a human, a company, a DAO, an AI - any entity that can hold and exercise authority.)

## The architecture, stated as a thesis

> The ECS _is_ a semantic graph. The semantic graph _is_ the multiplayer protocol. The multiplayer protocol _is_ the persistence layer. There is no impedance mismatch because there is no impedance.

- Components are SHACL shapes. Relationships are predicates. The same data model is what runs at high framerates in the simulation, what gets signed and replicated across peers, what gets persisted in agent perspectives, and what gets queried by SPARQL-equivalent pattern matching.
- Identity is a DID. Authority is an exclusive relation. Governance is a constraint expressed as data and enforced by every peer locally — no central server, no privileged validator.
- The engine is unopinionated about identity provider, transport, and persistence. Three runtime modes are first-class:
  - **Solo** — no peers, no signing, pure local; for tests and offline single-player.
  - **Local** — Ed25519 / did:key identity, signed in-memory transport, ZCAP governance; for local-network multiplayer.
  - **AD4M** — full distributed agent identity, Holochain-backed transport + persistence, AD4M capability governance.

You start an experience in solo, ship to a friend over local, eventually join a WE network and join the wider semantic web. Same code, same engine, three transports.

## The convergence path

Connection Engine is developed standalone today because the spatial primitives need their own design discipline and shipping cycle. The convergence with WE/AD4M happens in stages:

1. **Independent foundation** _(now)_ — Core ECS + engine + spatial primitives + Living Web primitives. Solo and local-mode runtimes ship. AD4M bridge is a working thin adapter.
2. **Co-located experiences** — WE 2D applets and Connection Engine 3D worlds sharing the same AD4M Perspectives. Edit a document in WE, see the spatial avatars referenced by it appear in a Connection Engine world.
3. **Unified distribution** — Connection Engine becomes a first-class WE applet kind. Spatial experiences are installable, composable, and recombinable the same way WE applets are today.
4. **Spec convergence** — Anything Connection Engine learns about expressing the semantic graph (SoA-tagged SHACL shapes, mutation-category-as-transport-selector, the runtime↔authored split) feeds back into the shared standards. Anything WE learns about social discovery, applet composability, perspective sharing flows back into the spatial layer.

## Why web standards

Every primitive is a web standard or in active standardisation:

- Identity: W3C DIDs, did:key
- Capabilities: W3C ZCAP-LD
- Credentials: W3C Verifiable Credentials
- Schema: W3C SHACL (over TypeBox-backed JSON Schema)
- Crypto: Web Crypto (Ed25519, SHA-512)
- 3D: WebGPU (current), WebXR
- Transport: WebRTC DataChannels (runtime), WebSockets (authored)
- Persistence: AD4M Perspectives over Holochain

There is no requirement on any specific browser vendor, OS, or app store. An experience built on Connection Engine runs in any browser that ships WebGPU. The agent identity that signs into it is the same agent identity that signs into a WE applet, an AD4M-backed messenger, or any other tool in the wider semantic sovereign network.

The primitives we're missing — the ones today's web doesn't ship — are tracked as **[W3C Living Web proposals](https://github.com/HexaField/w3c-living-web-proposals)**: a small set of foundational capabilities (agent-centric identity, signed semantic data, capability authorisation, peer-to-peer sync, governance-as-data) that, taken together, turn the browser into a sovereign-runtime host rather than a tenant of platform back-ends. Connection Engine, AD4M, WE, and the broader Coasys ecosystem are all converging on and iterating against these proposals — the engine is one of several implementations exercising the same shared primitives so they can mature into standards together rather than in isolation.
