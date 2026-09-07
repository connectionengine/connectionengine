# Connection Engine — agent notes

[`README.md`](./README.md) covers the project overview, the packages, the runtime modes, the quick start, and the license. [`VISION.md`](./VISION.md) covers the WE/AD4M convergence and the reason this project exists. This file does not repeat either one. Everything below is what the code, the `package.json` files, and the planning docs do not make obvious.

## Source of truth for design

The canonical engine design lives in `.specs/planning/ecs-network-exploration.md`. Per-tier specs in `.specs/01-..06-*.md` derive from that document. The current status lives in `.specs/planning/implementation-status.md`.

`.gitignore` excludes `.specs/`, so a fresh clone does not contain these files. Ask the maintainer for them when you need them.

When the code and the spec disagree on intent, follow the spec. The one exception is a commit message that records a reason for the difference.

## AD4M submodule — one-time setup gotcha

The `package.json` of `@coasys/ad4m` points `main`, `module`, and `types` at `lib/...`. The submodule does not check `lib/` in. The bridge package therefore cannot resolve `@coasys/ad4m` imports until the AD4M build has run:

```bash
git submodule update --init --recursive
pnpm install
pnpm --filter @coasys/ad4m build      # ← this is the non-obvious step
```

A fresh checkout that skips the build step produces TypeScript errors in `packages/ad4m-bridge/`.

**To bump AD4M:**

```bash
git submodule update --remote packages/ad4m
pnpm --filter @coasys/ad4m build
git add packages/ad4m && git commit -m "bump ad4m submodule"
```

## Layering — enforced, not just convention

`.oxlintrc.json` enforces three rules:

- Files in `packages/core/src/ecs/**` must not import from `../network/*`. This protects the foundation layer. Test files are exempt.
- `import/no-cycle` applies to all source files, to depth 10.
- The linter ignores `packages/ad4m/**`, `node_modules`, `dist`, `lib`, and `.codegraph`.

Do not add the import when this rule fails. Take one of two other actions instead. Move the missing concept down a layer. Or invert the dependency with a registered hook.

The precedent for inversion is `onWorldDestroy` in `ecs/world.ts`. `network/network.ts` registers a hook there, so `destroyWorld` closes networks without `ecs/` importing anything from `network/`.

**For type-only cycles inside one layer**, use an inline `import(...)` reference in the type position. Do not declare a forward interface. For example, `world.ts` refers to `ComponentSchema` as `Map<string, import('./component').ComponentSchema>`, and does not redeclare the interface, because the type belongs in `component.ts`. An inline import keeps the type definition in one place. It leaves no runtime import to join a cycle. It does not trigger `import/no-cycle`. Do not use the older pattern that duplicates an interface in a leaf module, because those copies drift.

## Code map (codegraph)

```bash
pnpm --filter @connectionengine/core map         # sync index + print status
pnpm --filter @connectionengine/core map:render  # also emit graph.md / graph.html / graph.json
```

The outputs land in `.codegraph/`, which `.gitignore` excludes. After `map` runs once, `npx codegraph query|callers|callees|impact|context|serve <symbol>` works from the repo root. Use it for impact analysis before a non-local refactor. The `serve` subcommand exposes the index as an MCP server, for editor and agent integration.

## Conventions

- **Do not commit unless asked.** Leave the changes in the working tree for the human to review. Run `git add` and `git commit` only when told to.
- **Never push to `main`, `dev`, or `master`.** Always use a feature branch. Use `--force-with-lease` for the force-push that a rebase on a feature branch needs.
- **Every fix needs a test that would have caught the regression.** There are no exceptions.
- **Verify end to end, not by type-check alone.** Run `pnpm run check` for the typecheck and oxlint. Run `pnpm run test` for vitest across all packages. Do both before you declare any work done.
- **No mocks, stubs, or placeholders in production code.** Do not commit `// TODO` or `throw new Error('not implemented')`.
- **Docs travel with code.** Every change to engine behaviour, to the public API, or to the mental model must land with matching updates in `docs-src/pages/*.mdx`. No commit may leave the docs describing the old shape. When a diff renames an identifier, removes a concept, or adds an option, update the documentation prose, the code blocks, and the `description:` frontmatter in the same commit. Search `docs-src/` for the old name before you declare the work done. Treat any hit as a regression.

## Things easy to miss

- **Component and relation definitions are global. Storage is per-engine.** `defineComponent({ id })` returns the same definition for the same id, in every engine. The SoA typed arrays live on the definition itself. The per-entity instance records and view bags live on the engine, in `engine.componentStores`.
- **Entity IDs belong to the engine, not to the world.** Two worlds that share an engine share one bitECS ID space. Two worlds with separate engines get independent ID spaces.
- **Entity IDs are runtime-local, and the engine never serialises them.** Identity on the wire uses BelongsTo and UID paths. See `getEntityPath` and `resolveEntityPath`.
- **`AuthoredEvent` is unsigned.** The mutation pipeline in core produces and consumes plain events. Signing and verification are runtime-mode concerns. The `local/` package signs with Ed25519. The `ad4m-bridge/` package delegates to the AD4M executor.
- **The `origin` tag prevents re-broadcast.** A mutation tagged `network`, which means the engine received it from a peer, does not re-enter the outbound queue. Break this and peers echo each other forever. The tests in `packages/core/tests/integration.test.ts` lock it in.
- **Solid signals do not work under the default `node` export condition of Vitest.** Both `local/` and `ad4m-bridge/` hold a `vitest.config.ts` that aliases `solid-js` to its dev build. Copy that config into any new workspace package that pulls Solid in transitively.
- **`pnpm run check` and `pnpm run test` can fail before they start.** pnpm refuses to run when a dependency has an unapproved build script, and reports `ERR_PNPM_IGNORED_BUILDS` instead of a compile error. Run `pnpm approve-builds` once, or pass `--config.verify-deps-before-run=false`.
- **A test that leaks a timer or an open handle hangs the whole run.** vitest reports the assertions as passed, then the worker spins at 100% CPU and never exits. If `vitest run` stops producing output while a core stays pegged, look at the file named in the last `stdout |` line rather than at the test that follows it.
