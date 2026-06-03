# Connection Engine — agent notes

What [`README.md`](./README.md) covers (project overview, packages, runtime modes, quick start, license) and [`VISION.md`](./VISION.md) covers (WE/AD4M convergence, why this exists) is not repeated here. Everything below is what isn't obvious from the code, the package.json files, or the planning docs.

## Source of truth for design

The canonical engine design lives at [`.specs/planning/ecs-network-exploration.md`](./.specs/planning/ecs-network-exploration.md). When the code and the spec disagree on intent, the spec wins — unless there's a reason captured in a commit message. Per-tier specs in `.specs/01-..06-*.md` are derived from the canonical doc; current status is in [`.specs/planning/implementation-status.md`](./.specs/planning/implementation-status.md).

## AD4M submodule — one-time setup gotcha

`@coasys/ad4m`'s `package.json` points its main/module/types at `lib/...`, which the submodule does not check in. The bridge package cannot resolve `@coasys/ad4m` imports until AD4M's own build has run:

```bash
git submodule update --init --recursive
pnpm install
pnpm --filter @coasys/ad4m build      # ← this is the non-obvious step
```

Fresh checkouts that skip the build step will get TypeScript errors in `packages/ad4m-bridge/`.

**Bumping AD4M:**

```bash
git submodule update --remote packages/ad4m
pnpm --filter @coasys/ad4m build
git add packages/ad4m && git commit -m "bump ad4m submodule"
```

## Layering — enforced, not just convention

`.oxlintrc.json` enforces:

- `ecs/**` may not import from `engine/**` or `network/**` (foundation-layer protection)
- `import/no-cycle` across all source files (depth 10)
- `packages/ad4m/**` is ignored

When this fails, the temptation is to "just add the import." Don't — surface the missing concept down a layer instead, or invert the dependency via a registered hook. The existing precedent is `entity.ts → registerRemoveHook(...)` in core, which lets `identity.ts` (higher layer) plug a cleanup callback into entity removal without `entity.ts` ever importing `identity.ts`.

**For type-only cycles within the same layer**, prefer inline `import(...)` references in type positions over a "forward-declared" interface. Example: `world.ts` references `ComponentSchema` via `Map<string, import('./component').ComponentSchema>` rather than redeclaring the interface, because the type properly lives in `component.ts`. Inline imports keep the type definition in one place, leave no runtime import to participate in a cycle, and don't trigger `import/no-cycle`. Avoid the older "duplicate interface in a leaf module" pattern — it drifts.

## Code map (codegraph)

```bash
pnpm --filter @connectionengine/core map         # sync index + print status
pnpm --filter @connectionengine/core map:render  # also emit graph.md / graph.html / graph.json
```

Outputs land in `.codegraph/` (gitignored). After `map` has run once, `npx codegraph query|callers|callees|impact|context|serve <symbol>` works from the repo root — useful for impact analysis before non-local refactors. The `serve` subcommand exposes the index as an MCP server for editor/agent integration.

## Conventions

- **No commits without explicit ask.** Leave changes in the working tree for the human to review; `git add`/`git commit` only when told.
- **Never push to `main` / `dev` / `master`.** Always feature branch. Force-pushes (when needed for rebase on a feature branch) use `--force-with-lease`.
- **Every fix needs a test that would have caught the regression.** No exceptions.
- **Verification is end-to-end, not just type-check.** `pnpm run check` (typecheck + oxlint) + `pnpm run test` (vitest across all packages) before declaring anything done.
- **No mocks/stubs/placeholders in production code.** `// TODO` and `throw new Error('not implemented')` are not acceptable in committed code.
- **Docs travel with code.** Every change to engine behaviour, public API, or mental model must land with matching updates in `docs-src/pages/*.mdx`. No commit may leave the docs describing the old shape. If a renamed identifier, removed concept, or new option appears in a diff, the documentation prose, code blocks, and `description:` frontmatter must all be updated in the same commit. Grep for the old name across `docs-src/` before declaring done; a non-empty hit is a regression.

## Things easy to miss

- **Components and relations are global definitions; storage is per-world.** `defineComponent({ id })` is idempotent across worlds (same id → same definition) but typed-array stores allocate per `World` instance, lazily on first set. Multiple worlds in the same process do not collide on entity IDs.
- **Entity IDs are runtime-local and never serialised.** Identity on the wire uses BelongsTo + UID paths (`getEntityPath` / `resolveEntityPath`).
- **`AuthoredEvent` is unsigned.** Core's mutation pipeline produces/consumes plain events; signing + verification are runtime-mode concerns (the `local/` package signs via Ed25519, `ad4m-bridge/` delegates to AD4M's executor).
- **The `origin` tag prevents re-broadcast.** A mutation tagged `network` (i.e. received from a peer) does not re-enter the outbound queue. This is the single most important invariant for the multi-peer system; tests in `packages/core/tests/integration.test.ts` lock it in.
- **Solid signals don't work under Vitest's default `node` export condition.** Both `local/` and `ad4m-bridge/` have a `vitest.config.ts` that aliases `solid-js` to its dev build. Copy this if you add a new workspace package that pulls Solid transitively.
