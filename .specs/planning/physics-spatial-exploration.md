# Connection Engine — Physics & Spatial Foundations Exploration

> **Scope:** Physics worker boundary, spatial primitives (Transform, colliders, spatial input, WebXR). This document covers the physics worker design in detail. The broader spatial foundations (Transform component, scene graph, spatial input, WebXR integration, renderer) will be added here when that exploration begins.

---

## 1. Worker Boundary (Physics)

### Decision

**Physics only in a web worker.** All other systems (IK, vehicles, grabbables, network IO, rendering, input) run on the main thread.

**Options considered:**

1. ~~No workers — everything on main thread.~~ Viable but leaves performance on the table for the one genuinely compute-heavy subsystem.
2. **Physics in a worker via SABs.** ✅ Simple boundary, physics library properly abstracted, ECS is the API.
3. ~~Full simulation pipeline in a worker.~~ Too much infrastructure — essentially building a local networking layer (mirrored worlds, event queues, entity creation coordination). Violates "fewest abstractions."

### Why physics only

- **Physics broadphase/narrowphase is the one real CPU hog** in a browser multiplayer engine. IK (few hundred bones), vehicles (simple kinematic math), grabbables (constraints, often tied to physics solver anyway) — none of these are bottlenecks at realistic browser entity counts.
- **Enforced abstraction boundary.** Forcing physics into a worker means the only interface is SoA stores (positions, rotations, velocities) + a minimal command channel. The physics library becomes hot-swappable (Rapier, Jolt, custom), bugs can't corrupt non-physics state, and testing in isolation is trivial. The "ECS is the API" principle is structurally enforced, not just conventional.
- **SoA architecture keeps the door open.** If IK or vehicles ever become bottlenecks, the same SAB pattern can be applied without redesigning the data model.
- **Network IO stays on main.** It's event-driven, not compute-bound. Serialization is fast over typed arrays. If it ever becomes a bottleneck, it can be offloaded independently.

### Shared data (SAB)

Physics worker reads/writes SoA stores via SharedArrayBuffer. **Main thread creates** growable SABs (`new SharedArrayBuffer(initial, { maxByteLength })`) and transfers references to the worker. Both threads see `grow()` atomically — no coordination or copying needed. Same pattern as existing `resizableArray` for regular ArrayBuffers. Set generous `maxByteLength` (virtual memory reservation is cheap). Supported in Chrome 111+, Firefox 128+, Safari 16.4+ — covers all SAB-capable browsers.

Shared SoA stores:

- **Transform** — position, rotation (worker writes after simulation step)
- **Velocity** — linear, angular (worker reads/writes)
- **Collider shape data** — dimensions, offsets (main writes, worker reads)
- **Physics body config** — mass, restitution, friction, type (main writes, worker reads)

### Interpolation

The worker runs a fixed timestep matching the simulation tick rate. Main thread runs at variable framerate. To avoid jitter:

- Worker writes **both current and previous** physics state to the SAB
- Main thread interpolates between previous and current based on the accumulator fraction
- At most fractions of a frame behind — imperceptible with transform interpolation

Exact interpolation buffer layout (two transform arrays vs double-buffer swap) deferred until the transform interpolation system is implemented.

### Collision events

Physics produces **discrete collision events** (entity A hit entity B, trigger entered/exited, contact points). These can't go through SAB (they're variable-length, discrete).

**Decision: `postMessage` with plain JS arrays (Option A).** Worker accumulates collision events during the simulation step, posts them to main thread at end of tick. Main thread processes in the next frame.

```typescript
// Worker side
const collisions: CollisionEvent[] = []
// physics callback: collisions.push({ entityA, entityB, type: 'start', normal, depth })
// end of tick: postMessage({ type: 'collisions', events: collisions })
```

This is sufficient because collision events are low volume (tens per frame), the structured clone cost is noise, and one frame of delivery latency is within budget for collision responses (damage, sound, triggers).

**Future options if needed:**

- **Option C: Transferable ArrayBuffer** — pack events into an `ArrayBuffer`, transfer ownership via `postMessage([buffer])`. Zero-copy, but requires binary packing/unpacking and buffer pooling. Worth considering if structured clone ever shows up in profiles.
- **Option B: SAB ring buffer with Atomics** — pre-allocated shared memory ring buffer for zero-allocation, synchronous reads on main thread. Maximum performance but significantly more complex (overflow handling, fixed event size, debugging difficulty). Only justified if collision queries need to be synchronous within the same frame.

### Command channel (main → worker)

Main thread sends commands to the physics worker:

- Add/remove physics body (entity created/destroyed with physics components)
- Update body config (mass, shape, type changed)
- Apply impulse/force
- Teleport (set position directly)

**Channel:** `postMessage` command queue, processed by worker at start of each tick.

### What the worker does NOT have

- No bitECS world of its own — it reads/writes shared SoA arrays but doesn't run queries or manage entities
- No observers, no event log, no relationships — all of that stays on main thread
- No network IO — main thread handles all transport
- The worker is a pure physics simulation loop: receive commands → step simulation → write results to SAB → flush collision events

### Physics library

**Havok** (TypeScript bindings maintained by Babylon) is the primary physics engine. Future support for Rapier, PhysX, and others via the same abstracted SAB boundary — the physics library is hot-swappable because the only interface is shared SoA arrays + `postMessage` commands.

Body ↔ entity mapping (how the worker maps physics body handles to entity IDs) is an implementation detail deferred until physics work begins.

---

## 2. Spatial Foundations (TODO)

To be explored when this scope is active. Will cover:

- **Transform component** — position, rotation, scale. Hierarchy inheritance via `ChildOf`. Local vs world transforms.
- **Collider components** — shape definitions (box, sphere, capsule, mesh, convex hull). Collider ↔ physics body mapping.
- **Spatial input** — ray casting, pointer events, XR controller input. Spatial queries for hit testing.
- **WebXR integration** — reference spaces, XR session lifecycle, stereo rendering, hand tracking, anchors.
- **Renderer interface** — how ECS data flows to WebGPU. See `research/webgpu-dimensionality-analysis.md` for the dimensionality analysis.
- **glTF ontology** — how glTF scene structure maps to ECS entities, components, and relationships.
- **XRUI** — spatial UI panels rendered as textures in 3D space.
