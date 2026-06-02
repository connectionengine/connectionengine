# Connection Engine — Implementation Status

Tracks what exists in the repo vs what's been designed.

## Repo

`~/workspaces/connectionengine/connectionengine` — `github.com/connectionengine/connectionengine`

## Codebase Status: Provisional / Exploratory

Everything in the repo is provisional and will need to be reworked following the ECS & Network exploration. The current code was written before the design work and serves as proof-of-concept for individual pieces, not as the foundation for the final implementation.

### What exists (provisional)

| Item | Location | Notes |
| --- | --- | --- |
| Monorepo scaffolding | Root | pnpm workspaces, 3 packages (core, server, client). CI, linting (oxlint/oxfmt), testing (Vitest/Playwright), pre-commit hooks. **This infrastructure is solid and stays.** |
| ECS core | `packages/core/src/ecs/` | `defineComponent`, `setComponent`, `getComponent`, `removeComponent`, `createEntity`, `removeEntity`, serialization. Built on bitECS + the current TypeBox-backed schema layer. **Will be reworked** — needs relationship-based identity (`BelongsTo` + `UIDComponent`), schema-driven network modes, observer-driven replication hooks, and authority/governance integration. |
| SoA math types | `packages/core/src/ecs/soa.ts` + `packages/core/src/maths/` | Vec2–4, Quat, Quat2 SoA classes with resizable typed arrays. **Likely survives mostly intact** — the SoA data layout is correct for the final design. |
| World + timer | `packages/core/src/engine/world.ts` | World creation, fixed timestep, isomorphic timer (browser/server). **Partially survives** — timer/timestep logic is sound, but World needs connection/session state, snapshots, and multiplayer/governance hooks. Spatial indices and zone logic now belong to the later spatial layer. |
| System phases | `packages/core/src/engine/system.ts` | Stub only — `createSystem` not implemented. **Will be replaced** with the full system model (execute + reactor, phase ordering, injection API). |
| Express server | `packages/server/` | Health endpoint only. Placeholder. |
| SolidJS client | `packages/client/` | Health status display only. Placeholder. |

### What needs to be built (from exploration doc)

See [`ecs-network-exploration.md`](./ecs-network-exploration.md) §9 (Implementation Dependency DAG) for the full tier-by-tier breakdown. The critical path starts with reworking the ECS core against the new design.
