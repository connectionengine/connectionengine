# The Semantic Spatial Web — From First Principles

> What a "semantic spatial web engine" really means, built up from the foundations of the web itself — and the five proposed web platform primitives that complete the picture.

---

## 1. What The Web Already Is

The web is the most successful distributed application platform ever built. Before adding anything, it's worth understanding what's already there.

### The document layer

The original web is a system of linked documents.

- **URIs** — universal addressing. Any resource, anywhere, gets a name that anyone can resolve.
- **HTTP** — stateless request/response. Cacheable, intermediary-friendly, built for unreliable networks.
- **HTML/CSS** — declarative structure and presentation. The browser is a runtime that interprets these declarations into visual output.
- **Hyperlinks** — the original semantic primitive. A link says "this resource is related to that resource." The web is, at its core, a graph of relationships between documents.

### The application layer

Over three decades, the web evolved capabilities that rival native platforms:

- **JavaScript + DOM** — imperative control over a live document tree
- **WebSockets** — persistent bidirectional channels
- **WebRTC** — peer-to-peer data, audio, and video with NAT traversal
- **WebTransport / QUIC** — multiplexed, low-latency transport
- **Web Workers + SharedArrayBuffer** — true parallelism with shared memory
- **WebGPU** — direct GPU compute and rendering, successor to WebGL
- **WebXR** — AR/VR device integration, spatial tracking, hand input
- **WebCodecs / WebAudio** — low-level media processing
- **Gamepad API** — game controllers and spatial input devices
- **Service Workers** — offline capability, background processing, push notifications
- **IndexedDB / Cache API** — local persistence
- **Web Crypto** — cryptographic primitives
- **WebAssembly** — near-native computation for any language

### The standards ecosystem

Thousands of RFCs and W3C specifications define the web's protocols and data formats:

- Networking: DNS, TLS, HTTP/2, HTTP/3, WebSocket, STUN/TURN/ICE, SDP, RTP
- Data: JSON, JSON-LD, JSON Schema, XML, Protocol Buffers (via WASM)
- Semantic: RDF, OWL, SPARQL, Schema.org, Linked Data
- Identity: DIDs (Decentralised Identifiers), Verifiable Credentials
- Social: ActivityPub (federated social networking)

The web has **everything** at the infrastructure level. Every capability needed for spatial, real-time, multiplayer, sovereign applications exists as a web standard or is built on web standards.

### What's missing

What the web lacks isn't infrastructure — it's **coherent higher-level primitives** for three things:

1. **Spatial experiences.** Everything is 2D document flow. Every 3D/spatial application (maps, games, AR, VR, CAD) builds its own spatial runtime from scratch.

2. **Semantic relationships.** HTML has structural semantics (`<article>`, `<nav>`) but no meaningful relationships between resources beyond hyperlinks. The original Semantic Web (RDF/OWL/SPARQL) attempted this and produced powerful standards, but failed at adoption because the tooling was hostile and the use cases were academic.

3. **Sovereign identity and data.** Your data lives on someone else's server. Your identity is a username on someone else's platform. There is no web-native way to own your data, your relationships, or your spaces.

---

## 2. The Living Web: Five Primitives the Web Platform Is Missing

The missing piece isn't more protocols — it's a set of **atomic web platform primitives** that make semantic, sovereign applications natural to build. The Living Web proposal identifies five, each expressed as a proposed addition to the browser's API surface: `navigator.graph` and extended `navigator.credentials`.

These are not project-specific concepts. They are proposed **web standards** — W3C-format draft specifications with neutral terminology, designed so that any framework can implement them. What follows is what the web needs, not what any single project provides.

### 2.1 Personal Linked Data Graphs

A `navigator.graph` API for browser-native semantic triple stores. A `PersonalGraph` is a local-first collection of `SemanticTriple`s — `(source, predicate, target)` — that belongs to the user, persists across sessions, and supports SPARQL queries. Like IndexedDB, but semantic.

This is the fundamental unit of data ownership. A PersonalGraph belongs to an agent. It can be private, shared with specific people, or published as a SharedGraph. You choose what's in it and who sees it.

Everything is expressed as semantic triples:

- A chat message: `(channel, hasMessage, messageExpression)`
- A social connection: `(alice, follows, bob)`
- A file in a folder: `(folder, contains, file)`
- A permission: `(agent, canEdit, resource)`

This is the same structure as RDF — but rather than operating over a global knowledge graph, triples exist within personal graphs. The semantics are local and contextual, not universal and absolute.

### 2.2 Decentralised Identity

An extension to `navigator.credentials` with DID key generation, secure storage, and Ed25519 signing. Identity lives in the browser like passkeys — no server, no extension. Each agent is the authority over their own data. No central arbiter decides what's true.

This is fundamentally different from:

- **Client-server** (the server is the source of truth)
- **Blockchain** (consensus is the source of truth)
- **Agent-centric** (each agent is the source of truth for their own data, convergence through shared rules)

### 2.3 P2P Graph Synchronisation

Share a graph with peers via `graph.share()`, join one with `navigator.graph.join()`. A `SharedGraph` is a PersonalGraph that multiple agents synchronise — transport-agnostic, working over WebRTC, Holochain, libp2p, or anything else. The browser manages sync in the background like push notifications.

A SharedGraph is the equivalent of a "server" or "room" — but sovereign. No single party controls it. Multiple agents agree on which `ContentProtocol`s to use (where data is stored and how it's structured) and which governance rules apply. The rules are shared and enforced locally by each participant.

### 2.4 Dynamic Graph Shape Validation

`GraphSchema` — SHACL extended with action semantics: constructors, setters, collections. Define a "Task" shape once; any app, agent, or UI can create, query, and modify Task instances. Schemas as portable, composable data — not locked inside an application.

This is not consensus (blockchain) or authority (server). A GraphSchema defines **what data looks like**. Combined with governance, it defines **what operations are valid**. The schema is shared; validation happens locally according to shared rules — the same mechanism that makes human social norms work.

### 2.5 Graph Governance

`GraphGovernance` — constraints enforced at the sync layer, the one component all peers agree on. Capability delegation (ZCAP), credential requirements (Verifiable Credentials), rate limits, content policies. Rules are graph data that evolve via sync, not code that needs redeployment. Governance as a protocol, not a platform feature.

This is the critical layer that makes SharedGraphs viable at scale. Without governance, any agent with sync access can add any triple. With governance, rules cascade down entity hierarchies, more specific scopes take precedence, and enforcement happens at the sync layer — before invalid triples enter the network.

### What these primitives give the web

| Gap | Living Web primitive |
| --- | --- |
| No native identity | Decentralised Identity — DIDs, keypairs, agent-centric identity via `navigator.credentials` |
| No data ownership | PersonalGraph — your data, stored where you choose, queryable with SPARQL |
| No semantic relationships | SemanticTriple — composable across applications, contextual within graphs |
| No interoperability | GraphSchema — shared SHACL shapes mean any app that knows the vocabulary can read any graph |
| No sovereignty | SharedGraph + GraphGovernance — shared rules, no central authority |

### Existing implementations

**AD4M** is the most complete existing implementation, covering all five primitives plus governance enforcement at the Holochain sync layer. Its concepts map directly: Perspective → PersonalGraph, Neighbourhood → SharedGraph, Link → SemanticTriple, Subject Class → GraphSchema, Social DNA → GraphGovernance, Language → ContentProtocol. An AD4M bridge polyfill implements `navigator.graph` by connecting to the AD4M executor — apps written against the neutral API work on AD4M without modification.

**Solid** covers triples, graphs, and schemas (via SHACL/ShEx) but is server-centric — pods on HTTP servers, not local-first P2P. It lacks agent-centric signing and peer synchronisation. The Living Web primitives could serve as Solid's client-side complement.

**AT Protocol** (Bluesky) has signed commits and personal data servers but uses JSON records, not semantic triples, and relies on federated relays rather than P2P sync.

**Nostr** has signed events and relay-based distribution but no semantic data model, no local graphs, no schemas, and no governance.

No single project implements all five primitives well. The Living Web specs draw from the strongest ideas across all of them — semantic triples from the RDF/Linked Data world, cryptographic signing from the P2P world, local-first graphs from the local-first movement, P2P sync from decentralised systems, and schema validation from the semantic web.

---

## 3. What Connection Engine Brings: The Spatial Real-Time Runtime

Connection Engine's insight is that a real-time multiplayer spatial experience is structurally the same thing as a SharedGraph — one where the triples happen to have spatial meaning and the data needs to update at 60fps.

### Entity Component System as a semantic graph

An ECS world is a graph of typed relationships:

- **Entities** are subjects
- **Components** are typed property sets (GraphSchema instances)
- **Relationships** are predicates linking entities to entities

When you write:

```
query(world, [ChildOf(scene), Transform, Not(Static), OwnedBy(user)])
```

You're asking: "find all non-static, owned, spatially-positioned entities that are children of this scene." This is a **semantic query** over a graph of typed relationships — SPARQL for spatial state, running at 60fps.

The difference between an ECS query and a Semantic Web query is performance, not expressiveness. RDF/SPARQL operates over arbitrary triple stores with global reasoning. ECS queries operate over archetype-indexed tables with local reasoning. Same structure, different trade-offs — and the ECS trade-offs (fast, local, typed) are exactly right for real-time spatial applications.

### The structural isomorphism

Connection Engine and the Living Web primitives share the same deep structure:

| Living Web Primitive | Connection Engine Concept | AD4M Term | Same concept |
| --- | --- | --- | --- |
| SemanticTriple `(source, predicate, target)` | Entity relationship `(subject, relation, target)` | Link | ✓ |
| PersonalGraph (collection of triples) | World (collection of entities + relationships) | Perspective | ✓ |
| SharedGraph (synced graph with rules) | Network (shared world with agent-centric rules) | Neighbourhood | Structural parallel — not necessarily 1:1 mapping |
| GraphGovernance (constraint enforcement) | Permissions (event validation rules) | Social DNA | ✓ |
| GraphSchema (SHACL shape with actions) | ComponentDefinition (TypeBox schema — typed structure on entity) | Subject Class | ✓ (see §5) |
| Decentralised Identity (DID agent) | User (with peers across devices) | Agent | ✓ |
| ContentProtocol (pluggable storage) | Transport (pluggable network backend) | Language | Partial |
| SignedContent (signed data object) | Component data / Event | Expression | Partial |

These aren't analogies. They're structural isomorphisms. A Connection Engine world IS a PersonalGraph where the predicates include `ChildOf`, `OwnedBy`, `AuthoritativeFor`, `InNetwork`, and where some content is continuous spatial data (positions, rotations) that needs to stream at tick rate. Note that `BelongsTo` (ownership/identity association) and `ChildOf` (scene hierarchy) are distinct predicates serving different semantic purposes — a peer `BelongsTo` a user, while an entity is `ChildOf` a scene node.

### What makes it a web engine, not a game engine

A game engine (Unity, Unreal) creates self-contained interactive experiences. A **web engine** creates experiences that are:

- **Linked** — entities have URIs, relationships are navigable, spaces link to other spaces
- **Addressable** — any entity in any space can be referenced from anywhere
- **Composable** — a scene authored by one person can be loaded into a world hosted by another
- **Sovereign** — participants own their data, their identity, and their spaces
- **Standard** — built entirely on web primitives (WebGPU, WebXR, WebRTC, Web Crypto)

The browser gives you `document.querySelector()` to find elements by structure. Connection Engine gives you `query(world, [ChildOf(scene), Transform, Health])` to find entities by semantic and spatial criteria.

The browser is a runtime for document-based applications. Connection Engine is a runtime for spatial applications. Both run in a tab. Both use web standards. Both are open.

---

## 4. SharedGraphs as Spaces

This is the architectural insight that unifies everything.

A SharedGraph already has:

- **Shared state** — triples in the synced graph
- **Shared rules** — GraphGovernance constraints defining what's valid
- **Participants** — agents who've joined
- **Content** — data stored via ContentProtocols

Add spatial semantics and a SharedGraph **becomes a space**:

- **Entity positions** expressed as component data on entities (triples with spatial predicates)
- **Scene hierarchy** expressed as `ChildOf` relationships between entities
- **Physics, constraints, interactions** expressed as components and rules
- **Reference spaces** — a WebXR concept that gives an entity hierarchy a pose (translation, orientation) and uniform scale relative to the device/session. This enables miniature mode, AR world-scale matching, avatar height resizing, etc. A SharedGraph could _also_ specify real-world coordinates if it represents an AR-anchored space, but this is distinct from the WebXR reference space concept — one is device-relative, the other is world-anchored.
- **Spatial rules** in the governance constraints — not just "who can post" but "who can move this object," "what happens on collision," "who has authority over this region"

The SharedGraph IS the network. The agents ARE the peers. The triples ARE the entity-component-relationship graph. The GraphGovernance constraints ARE the permissions and game rules.

Note: the mapping between SharedGraphs and engine networks is not necessarily one-to-one. The engine requires a web of many-to-many relationships for true dynamism — a single SharedGraph might span multiple engine networks, or multiple SharedGraphs might feed into a single world. The exact mapping needs further design as both systems mature.

Connection Engine is the runtime that makes this graph spatial and real-time — interpreting the semantic triples as positions, rotations, hierarchies, physics bodies, and rendering them through WebGPU at interactive frame rates.

---

## 5. Components Are Graph Schemas

ECS components and GraphSchema shapes are the same concept expressed in different contexts. A GraphSchema (SHACL shape with action semantics) is a typed lens over graph data — "a Channel is any entity with these predicates and properties, and here's how you create one, update its fields, and manage its collections." A component definition is a typed schema on an entity — "a Transform is any entity with position, rotation, and scale."

The Living Web's Dynamic Graph Shape Validation spec makes this concrete. SHACL is extended with **action semantics** — constructors define how to instantiate a shape, setters define how to update properties, and collections define how to manage ordered/unordered sets. This isn't aspirational; the polyfills implement it today with 53 conformance tests passing.

The same component can be expressed as a TypeBox schema (what the engine uses at runtime), a JSON Schema (what gets shared and edited), and a SHACL shape (what the Living Web APIs use for validation, querying, and auto-generated tooling). These are three representations of the same semantic structure:

### TypeBox (runtime)

```typescript
const Health = defineComponent(
  'Health',
  Type.Object({
    current: Type.Number({ default: 100 }),
    max: Type.Number({ default: 100 })
  })
)
```

### JSON Schema (shareable, AI-editable)

```json
{
  "type": "object",
  "title": "Health",
  "properties": {
    "current": { "type": "number", "default": 100 },
    "max": { "type": "number", "default": 100 }
  },
  "required": ["current", "max"]
}
```

### SHACL with action semantics (Living Web GraphSchema)

```turtle
<ce://HealthShape>
    a sh:NodeShape ;
    sh:targetClass <ce://Health> ;
    sh:property [
        sh:path <ce://has_current_health> ;
        sh:datatype xsd:float ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:defaultValue 100
    ] ;
    sh:property [
        sh:path <ce://has_max_health> ;
        sh:datatype xsd:float ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:defaultValue 100
    ] .
```

The pipeline is now concrete: TypeBox generates JSON Schema natively — they're the same thing at different levels. The SHACL shape is what the Living Web APIs use to validate triples in the graph, auto-generate SPARQL-queryable structures, and — critically — **auto-generate MCP tools for AI agents**. When a GraphSchema is registered, any AI agent connected via MCP gets typed create/read/update/delete tools for that shape's instances automatically. The schema becomes the API.

This means ECS component schemas are directly interoperable with the Living Web's graph system. A component defined in Connection Engine can be queried via SPARQL through `navigator.graph`, validated by SHACL, manipulated by AI agents through auto-generated MCP tools, and shared across applications — all from the same definition.

---

## 6. ECS Queries Are Semantic Queries

Every ECS query is a semantic operation over a typed relationship graph.

```
// "All entities that are children of this scene, have a transform, and are owned by someone"
query(world, [ChildOf(scene), Transform, OwnedBy(Wildcard)])

// "All entities in this network zone with health below 50"
query(world, [InNetwork(zone), Health])  // + filter Health.current < 50

// "All peers belonging to this user"
query(world, [BelongsTo(user), PeerComponent])

// "Everything attached to this vehicle"
query(world, [AttachedTo(vehicle)])
```

Each of these is equivalent to a SPARQL query:

```sparql
SELECT ?entity WHERE {
  ?entity childOf scene:123 .
  ?entity rdf:type Transform .
  ?entity ownedBy ?someone .
}
```

The ECS executes these at O(1) per archetype table, thousands of times per second. The semantic expressiveness is identical. The performance characteristics are what make it suitable for real-time spatial applications.

**Components are GraphSchema shapes** — a typed schema of properties that can be attached to any entity. **Relationships are predicates** — typed, queryable, first-class links between entities. **Queries are pattern matching over the graph** — find entities that match a set of type + relationship constraints.

This isn't a metaphor. It's the same data model, optimised for different access patterns. The Living Web primitives formalise at the web platform level what ECS engines have always done at the runtime level.

---

## 7. Two Runtimes, One Web Platform

WE and Connection Engine share the same application architecture — one for 2D, one for 3D. Both build on the same Living Web primitives. Understanding both reveals their inevitable convergence.

### Two runtimes, one pattern

| Layer | WE (2D social/productivity) | Connection Engine (3D spatial/real-time) |
| --- | --- | --- |
| **Web API** | `navigator.graph` for 2D apps | `navigator.graph` for 3D spatial experiences |
| **Data model** | Block types (GraphSchema shapes — SHACL with actions) | Component definitions (TypeBox schemas with network annotations) |
| **Data storage** | SemanticTriples in PersonalGraphs (RDF triples) | Entity components + relationships (semantic graph, SoA arrays) |
| **Declarative logic** | JSON schemas (`$query`, `$if`, `$map`, `$validate`) | JSON Logic (rules, conditions), SPARQL-style ECS queries |
| **Runtime** | Core SolidJS components (DOM rendering) | ECS systems: continuous (execute loop) + reactive (DOMless SolidJS) |
| **Custom code** | Custom stores (rare) | Custom systems (rare) |
| **Shareable unit** | Template = schema + block type dependencies (JSON) | Scene = entity hierarchy + component data + rules (event log or snapshot) |
| **AI integration** | GraphSchema → auto-generated MCP tools for CRUD | Component schemas → auto-generated queries for entity manipulation |

In WE, an app is **block types** (reusable data models defined as GraphSchema shapes) + **JSON schemas** (declarative UI: layout, data bindings via `$query`, local state via `$localState`, validation via `$validate`) + **core components** (SolidJS rendering primitives) + rarely **custom stores** (imperative state for complex interactions).

In Connection Engine, an experience is **component definitions** (reusable TypeBox schemas defining data, storage, and network behaviour) + **serialised JSON logic** (declarative behaviour: JSON Logic for rules/conditions, ECS queries for entity selection) + **ECS systems** (continuous execute loops + reactive DOMless SolidJS logic trees) + rarely **custom systems** (imperative logic for complex behaviour). Entity hierarchies are stored as semantic data (equivalent to RDF triples via `navigator.graph`) plus referenced assets (glTF, MP3, WEBM).

Both achieve composability by making the application definition **data, not code**. The hardcoded runtime (SolidJS components / ECS systems) is a fixed, trusted layer that interprets declarative data into real-time output. The data is freely shareable, forkable, AI-editable. The runtime is what makes it real.

### Shared foundation, different output targets

This parallel isn't coincidental. Both WE and Connection Engine are application runtimes built on the same Living Web primitives:

- **Same identity** — both use `navigator.credentials` for DID-based agent identity
- **Same data model** — both store and query SemanticTriples in PersonalGraphs and SharedGraphs
- **Same schemas** — both define data shapes that are portable, composable, and AI-accessible via auto-generated MCP tools
- **Same governance** — both use GraphGovernance for permission enforcement at the sync layer
- **Same sovereignty** — participants own their data, identity, and spaces in both

The difference is the output: WE renders to DOM, Connection Engine renders to WebGPU/WebXR. The convergence becomes even more natural because they share the same underlying web APIs — `navigator.graph` doesn't care whether the data it holds will be rendered as a 2D interface or a 3D world.

### The convergence

These runtimes will merge, because the boundary between 2D and 3D is artificial. A chat interface is 2D — until you want spatial presence. A 3D world needs 2D — for menus, inventories, HUDs. A document is 2D — until annotations are anchored in space. Every sufficiently rich experience needs both.

The merged runtime treats 2D and 3D as **rendering targets for the same semantic data**. A block type and a component definition become the same thing: a typed data model rendered as DOM, a 3D object, or both. A JSON schema and a serialised scene become the same thing: a declarative definition with both flat and spatial dimensions.

WE is The Anything App. Connection Engine is The Anything Space. Together, they are **The Anything Experience** — a single sovereign runtime where "app" and "space" dissolve into SharedGraphs over semantic data, rendered to whatever surface the moment demands.

---

## 8. The Anything Space

### The existence proof

The Living Web work produced a multiplayer 3D game demo — a Three.js world with WASD movement, collectibles, a leaderboard, and chat, all running on the five Living Web primitives. Player positions sync via SharedGraphs. Collectibles use first-write-wins governance constraints. Anti-cheat velocity limits are enforced at the sync layer via GraphGovernance. The game works by opening two browser tabs — no server, no install, just `navigator.graph`.

This demo is the existence proof that real-time spatial multiplayer works on these web platform primitives. But it's bespoke Three.js code — hand-wired rendering, manual state management, no physics engine, no ECS, no WebXR. Every spatial experience built this way would reinvent the same wheels.

Connection Engine is what replaces that bespoke code with a proper runtime: ECS for state management, WebGPU for rendering, a physics engine in a worker via SharedArrayBuffer, WebXR integration, spatial audio, gamepad input, networked authority with per-entity ownership. The Living Web demo proves the primitives work. Connection Engine makes them practical at scale.

### The three-tier deployment model

The Living Web specs define a three-tier path to browser support:

1. **Polyfill** — npm packages that implement `navigator.graph` using IndexedDB, WebRTC, Web Crypto, and standard web APIs. Works in any browser today. This is where Connection Engine runs now.

2. **Chrome extension** — a Manifest V3 extension that injects the polyfills into any web page. Install once, every website gets `navigator.graph`. The MetaMask-for-personal-data approach.

3. **Native browser** — a Chromium fork (76 tests passing on macOS arm64 and Linux x86_64) proves the specs can be implemented as browser-native subsystems. C++/Rust triple store, OS keychain for keys, background sync that survives tab close.

Connection Engine works at all three tiers. Today it works with polyfills — no browser changes required. The Chrome extension removes the npm import step. Native browser support makes everything faster (native triple store, background sync, OS keychain for identity) but isn't a prerequisite. The engine's `navigator.graph` calls resolve the same way regardless of which tier provides the implementation.

### The metaverse, reframed

The metaverse as pitched by platform companies is "a 3D world you visit." The actual metaverse is the web platform extended with spatial semantics and sovereign ownership.

It isn't a destination. It's a capability. Any SharedGraph can become spatial by adding spatial triples and governance rules. You don't "go to the metaverse" — you add spatial dimensions to whatever shared context you're already in.

- A chat room gains spatial presence when participants have positioned avatars
- A document gains spatial annotation when comments anchor to 3D coordinates
- A game exists when entities have physics, rules, and win conditions
- A meeting happens when voice is spatialised and participants share a reference space

The space is defined by the data and the rules. The engine makes those definitions real-time and spatial.

---

## 9. The Full Stack

| Layer | Web Standards | Living Web Primitives | Connection Engine |
| --- | --- | --- | --- |
| **Addressing** | URIs | DIDs for agents via `navigator.credentials`, PersonalGraphs for data via `navigator.graph` | Entity identity via relationships + naming |
| **Relationships** | Hyperlinks | SemanticTriples `(s, p, o)` | Entity relationships `(subject, relation, target)` — queryable at 60fps |
| **State** | Stateless HTTP, server databases | Agent-owned PersonalGraphs, local-first | Shared spatial state — ECS worlds, per-entity authority, event-sourced |
| **Rules** | Server-enforced (CORS, auth) | GraphGovernance — declarative constraints, agent-validated at sync layer | Permissions — same pattern, applied to spatial operations |
| **Schemas** | JSON Schema | GraphSchema — SHACL with action semantics (constructors, setters, collections) | ComponentDefinitions — TypeBox schemas generating JSON Schema and SHACL |
| **Real-time** | WebSocket, WebRTC, WebTransport | P2P Graph Sync (eventually consistent, transport-agnostic) | Continuous streams + discrete events, agent-centric networking |
| **Rendering** | DOM (2D document flow) | — | WebGPU + WebXR (3D spatial rendering) |
| **Compute** | JS, WASM, Web Workers | — | ECS systems, physics in worker via SAB |
| **Interaction** | Mouse, keyboard, touch | — | Spatial input, gamepad, XR controllers, multi-user same-device |
| **Persistence** | IndexedDB, server databases | ContentProtocols (pluggable backends) | Event logs, snapshots, authored scenes |
| **Identity** | Cookies, OAuth | Decentralised Identity (DIDs, Ed25519, browser-managed keys) | Users (with DIDs), peers (engine instances) |
| **Sovereignty** | None (platform-owned) | Full (agent-owned PersonalGraphs, SharedGraphs with governance) | Full (participant-owned spaces with shared rules) |
| **AI** | — | GraphSchema → auto-generated MCP tools | Component schemas → auto-generated entity manipulation tools |
| **Deployment** | Browser | Polyfill → Chrome extension → native browser | Works at all three tiers |

The semantic spatial web isn't a new internet. It isn't a new protocol. It's the **completion of the existing web platform** — and the Living Web specs make this literal. These are proposed additions to the web platform itself, filling the gaps in spatial, semantic, and sovereign capabilities using standards that already exist, unified by a data model that's already proven in game engines but never properly connected to the web's linking, addressing, and identity infrastructure.

The Living Web primitives provide the semantic + sovereign layer — `navigator.graph` and extended `navigator.credentials` as web platform APIs. Connection Engine provides the spatial + real-time layer — an ECS runtime that reads and writes those same graphs at 60fps. Together they make the browser a runtime for shared spatial experiences where participants own their data, their identity, and their spaces.

AD4M is the most complete implementation of the Living Web primitives today, and the natural backend for production deployments. But the primitives are bigger than any single project. Any framework that implements `navigator.graph` — whether via polyfill, extension, native browser code, or an AD4M bridge — gives Connection Engine its semantic foundation. The engine doesn't depend on AD4M. It depends on web platform APIs that AD4M happens to implement most completely.

---

_The web gave us linked documents. The Living Web gives us linked data with sovereignty — `navigator.graph` as a browser primitive, with identity, sync, schemas, and governance built in. Connection Engine gives us linked spaces with real-time spatial semantics. WE gives us composable sovereign apps. Together, they converge into a single runtime where apps and spaces are the same thing — SharedGraphs over semantic data, rendered to whatever surface the moment demands. The metaverse isn't a place. It's this runtime, and it runs in a browser tab._
