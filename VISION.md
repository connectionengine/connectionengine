# Connection Engine — Vision

## The short version

**Connection Engine is the 3D analogue of [WE](https://github.com/coasys/we) — and one day it will be distributed with it.**

WE and AD4M together form the **semantic sovereign runtime**: agent-centric and peer-to-peer, where every meaningful piece of data is a signed semantic statement, and every user is a cryptographic agent rather than a row in someone's database. Today WE delivers that runtime through 2D web surfaces — documents, links, perspectives, and tools.

Connection Engine adds the **spatial** dimension. Same agents, same signed semantic statements, same governance. The surface becomes real-time multiplayer 3D, which suits collaborative virtual worlds, XR environments, spatial knowledge gardens, and games. Put the two together and you get a **spatial semantic sovereign runtime**: decentralised, built on web standards, with cryptographic provenance in every change of state.

## Why?

The web grew around documents. The spatial web — VR, AR, multiplayer 3D — still grows around closed platforms such as Roblox, Unity Cloud, and Meta Horizon. Each platform is an enclosure. Each one owns your identity, your data, your social graph, and your creations. Each one extracts rent from the relationships you build inside it.

The agent-centric, peer-to-peer alternative now exists for the document web, through Holochain, AD4M, and WE. The spatial web still lacks that alternative: an engine that lets you bring your own agent, your own perspectives, and your own governance into any 3D experience, and that leaves your creations yours.

Connection Engine is that engine.

(Note: "agent" means a cryptographic identity that can sign statements and delegate authority. It does not necessarily mean an AI. An agent can be a human, a company, a DAO, or an AI — any entity that can hold and exercise authority.)

## The architecture, stated as a thesis

> The ECS _is_ a semantic graph. The semantic graph _is_ the multiplayer protocol. The multiplayer protocol _is_ the persistence layer. There is no impedance mismatch because there is no impedance.

- Components are SHACL shapes. Relationships are predicates. One data model does four jobs. It runs at high framerates in the simulation. It is signed and replicated across peers. It is persisted in agent perspectives. It answers SPARQL-equivalent pattern matching.
- Identity is a DID. Authority is an exclusive relation. Governance is a constraint expressed as data, and every peer enforces it locally. There is no central server and no privileged validator.
- The engine stays unopinionated about the identity provider, the transport, and the persistence layer. Three runtime modes get equal support:
  - **Solo** — no peers, no signing, purely local. For tests and offline single-player.
  - **Local** — Ed25519 / did:key identity, signed in-memory transport, ZCAP governance. For local-network multiplayer.
  - **AD4M** — full distributed agent identity, Holochain-backed transport and persistence, AD4M capability governance.

You start an experience in solo mode. You send it to a friend over local mode. You eventually join a WE network, and through it the wider semantic web. Same code, same engine, three transports.

## The convergence path

Connection Engine develops standalone today, because the spatial primitives need their own design discipline and their own release cycle. The convergence with WE and AD4M happens in stages:

1. **Independent foundation** _(now)_ — core ECS, engine, spatial primitives, and Living Web primitives. The solo and local-mode runtimes work. The AD4M bridge works as a thin adapter.
2. **Co-located experiences** — WE 2D applets and Connection Engine 3D worlds share the same AD4M Perspectives. Edit a document in WE, and the spatial avatars that it references appear in a Connection Engine world.
3. **Unified distribution** — Connection Engine becomes a WE applet kind in its own right. Spatial experiences become installable, composable, and recombinable, exactly as WE applets are today.
4. **Spec convergence** — everything Connection Engine learns about expressing the semantic graph feeds back into the shared standards. That includes SoA-tagged SHACL shapes, the use of the mutation category as the transport selector, and the runtime↔authored split. Everything WE learns about social discovery, applet composability, and perspective sharing flows back into the spatial layer.

## Why web standards

Every primitive is a web standard, or is in active standardisation:

- Identity: W3C DIDs, did:key
- Capabilities: W3C ZCAP-LD
- Credentials: W3C Verifiable Credentials
- Schema: W3C SHACL (over TypeBox-backed JSON Schema)
- Crypto: Web Crypto (Ed25519, SHA-512)
- 3D: WebGPU (current), WebXR
- Transport: WebRTC DataChannels (runtime), WebSockets (authored)
- Persistence: AD4M Perspectives over Holochain

No specific browser vendor, operating system, or app store is required. An experience built on Connection Engine runs in any browser with WebGPU. The agent identity that signs into it is the same agent identity that signs into a WE applet, an AD4M-backed messenger, or any other tool in the wider semantic sovereign network.

The **[W3C Living Web proposals](https://github.com/HexaField/w3c-living-web-proposals)** track the primitives that today's web lacks: agent-centric identity, signed semantic data, capability authorisation, peer-to-peer sync, and governance-as-data. Together those capabilities let the browser host sovereign runtimes instead of renting space from platform back-ends. Connection Engine, AD4M, WE, and the wider Coasys ecosystem all converge on these proposals and iterate against them. Several implementations exercising the same primitives is how those primitives mature into standards.
