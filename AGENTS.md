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

There used to be a third option — a `onWorldCreate` / `onWorldDestroy` hook registry in `ecs/world.ts`. It is gone. See the next section for what replaced it, and reach for one of the two options above rather than reintroducing a registry.

## The governing principle: every effect owns its undo

One rule sits above the specific conventions below. **The site that causes an effect also names what reverses it.** No registry, no watcher, no procedure a caller has to remember.

The test to apply before adding anything: _"If someone deletes this call, what else must they remember to delete?"_ The answer has to be **nothing**. When the answer names a second site, the design has a gap that will eventually go unmaintained.

Three forms this takes, in rough order of preference:

1. **A counter-verb at the same level.** `setComponent`/`removeComponent`, `addRelation`/`removeRelation`, `setUID`/`removeEntity`. Forward and reverse live in the same module and author together.
2. **Setup registers teardown.** When the reversal fires on its own schedule rather than on a call — a connection dropping — the setup registers it then and there. `attachConnection` adds the connection _and_ registers `disconnectPeer` on `connection.onClose`.
3. **The owner does its own cleanup.** `destroyWorld` closes the networks the world holds, because the world holds them.

Two supporting rules make those work:

- **State lives with the thing it describes, and so do its accessors.** A relation's index lives on the relation (`OwnedBy.get`), per-world pipeline state lives on the world, and a network's behaviour lives on the network, fixed when it is built. A fact stored away from its subject drifts from it, and so does a `getX` free function.
- **Capture before you mutate.** A reversal often needs facts the mutation destroys. `removeEntity` captures the path and the relation indexes _before_ the bitECS cascade, because neither survives, and because entity ids recycle immediately — a lookup deferred to flush time can answer for a different entity.

What this forbids: global callback registries, watchers that reconstruct a cause from its symptom, mutable behaviour fields, and cleanup procedures that several call sites must each remember. Every one of those has already been tried in this codebase and removed.

**Mechanism and policy split across the layer boundary, and only mechanism has to be symmetric.** `removeEntity` queues a destroy — mechanism, in `ecs/`. `flushAuthored` decides whether it travels — policy, in `network/`. That split is what lets `ecs/` stay ignorant of ownership while still authoring the reverse of its own verb.

## Every mutation verb authors its own reverse, inline

`ecs/component.ts` and `ecs/relation.ts` push to `world.authoredQueue` at the point of the mutation, forward and reverse together:

| forward        | reverse           |
| -------------- | ----------------- |
| `setComponent` | `removeComponent` |
| `addRelation`  | `removeRelation`  |
| `setUID`       | `removeEntity`    |

So `ecs/` writing to the authored queue is deliberate and symmetric, not a leak. **Do not add a fifth authoring site anywhere else, and never recover a mutation from an observer.** Entity removal was the one exception for a while: it authored nothing, and `network/mutation.ts` reconstructed the event from an observer on `onRemove(UIDComponent)`, registered through a world hook. That cost three defects at once, all now covered by tests in `tests/regressions.test.ts`:

- **N× fan-out.** `observe()` registers per _engine_, but the hook fired per _world_. One removal ran the handler once for each world sharing the engine, each time with a different `world` closed over.
- **A leak.** `observe()` returns an unsubscribe. The registration discarded it, so a destroyed world kept reacting to every later removal in that engine.
- **A tree-shaking hazard.** Registration happened in a side-effect-only import. A bundler dropping it dropped replication, silently.

**Queueing is not sending.** `removeEntity` queues every named removal and `flushAuthored` applies the ownership gate, because who may announce a removal is a distribution question rather than an ECS one. Keep policy in the flush and mechanism in the verb.

**Capture before you mutate.** `removeEntity` records the path and the relation indexes _before_ the bitECS removal: the cascade takes the relations and `cleanupIdentity` takes the path. The capture stays generic — `captureRelationIndexes` collects whatever the defined relations declare, so `ecs/` names no network concept — and `flushAuthored` reads the `OwnedBy` entry out of it.

**An exclusive relation may declare `index: true` in `defineRelation`.** `addRelation` and `removeRelation` then maintain a per-engine subject → target map, so no caller keeps it by hand. The index earns its place by answering after the subject has gone, which the relation cannot. `cleanupIdentity` clears the entry once the capture has happened, because ids recycle straight away — measured, not assumed.

**`index: true` requires `exclusive: true`, and the compiler enforces it.** An index holds one target for each subject. A non-exclusive relation holds many, so the pair gives a map that disagrees with its own relation. The second `addRelation` overwrites the first entry. Removing whichever target the entry names then clears it while the others still stand, so the index reports _no_ target for a subject that has one. `RequireExclusiveIndex<O>` makes the pairing a type error, and `defineRelation` throws for a caller that arrived without types. If a one-to-many index is ever needed, add it as a separate option with a `Map<Entity, Set<Entity>>` shape. Do not loosen this one.

**The accessors come with it: `get`, `set`, and `indexFor` on the definition.** A relation index always maps one entity onto another, so the option is a boolean and the types live in `defineRelation`'s return signature. Write `OwnedBy.get(world, entity)`, not a `getOwner` free function — the accessor cannot drift away from the relation it reads, and there is one name to find rather than two. A relation that omits the option carries no accessors, and the conditional return type makes calling one a compile error. `OwnedBy`, `AuthoritativeFor`, and `BelongsTo` all declare it.

**Components take the same shape where it fits.** `UIDComponent.get(world, entity)` replaced `getUID`. The two UID indexes are shaped differently from a relation index — one maps to a string, the other nests two levels — so they stay typed extension properties with `uidOfFor` and `nameCacheFor` for map-level work. Do not add a generic `get` to `defineComponent`: bare keys on a component definition belong to its SoA stores, so a schema field named `get` would collide.

**Tests assert on what travels, not on `authoredQueue`.** The queue is an intermediate that legitimately holds entries the flush drops. Use the `flushedDestroys` helper in `tests/regressions.test.ts`.

## Pair a teardown with its setup, in one function

`attachConnection(world, network, connection)` adds the connection to its network and registers `disconnectPeer` on `connection.onClose` in the same call. Attaching is what registers the detach, so no call site can do one without the other, and `onClose` covers every way a connection ends.

Prefer this over both alternatives that came before it: a cleanup procedure several call sites must remember, and an observer watching for the state change. `ConnectedTo` remains as queryable state — a fact, not a trigger.

## Behaviour is fixed at construction — no mutable hooks on runtime objects

A `Network` carries four behaviours: `onPublishAuthored`, `onPublishRuntime`, `onValidateAuthored`, `onRejected`. All four are **readonly**, supplied to `addNetwork` and never reassigned.

Callers never read those fields. They call the module-level dispatchers in `network/network.ts`:

```ts
publishAuthored(world, network, envelope)
publishRuntime(world, network, dirty)
validateAuthored(world, network, event) // → boolean
reportRejected(world, network, event, reason)
```

Rules that follow from this:

- **Never add a mutable hook field to a runtime object.** A field that any module may reassign makes the object's behaviour depend on call order, and the only way to find the answer is to grep for assignments.
- **To change behaviour, build a different object.** `connectAd4m` adds its own `'ad4m'` network rather than overriding the default one, and removes it on close.
- **`ensureDefaultNetwork(world, options)` applies its options only when it creates the network.** A second caller cannot re-teach an existing one. Where two entry points must agree — `createLocalRuntime` and `connectLocalInMemory` in `local/` — both pass the _same_ function values, so either creation order gives the same result.
- **The same rule applies to the observer pattern.** Side effects that used to be procedures other code had to remember to call are now derived from component state: entity removal replicates from `onRemove(UIDComponent)` gated on ownership, and disconnect cleanup runs from `onRemove(ConnectedTo)`. Prefer an observer over a function four call sites must remember.

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
- **Reference docs state what is, not what was.** No changelog narration in `docs-src/` — a reader wants the current behaviour, and git holds the history. In code comments, write the forward-looking form: "Do not recover this from an observer, because `observe` registers per engine" beats "this used to be an observer, which had three faults". The rule survives; the story rots.
- **No empty negation, no reassurance, no self-praise.** Cut "Nothing about it is special", "costs you nothing", "that is intentional", "simply", "elegantly". A sentence that only tells the reader how to feel about the design carries nothing. State the fact and stop.
- **Docs travel with code.** Every change to engine behaviour, to the public API, or to the mental model must land with matching updates in `docs-src/pages/*.mdx`. No commit may leave the docs describing the old shape. When a diff renames an identifier, removes a concept, or adds an option, update the documentation prose, the code blocks, and the `description:` frontmatter in the same commit. Search `docs-src/` for the old name before you declare the work done. Treat any hit as a regression.

## Things easy to miss

- **Component and relation definitions are global. Storage is per-engine.** `defineComponent({ id })` returns the same definition for the same id, in every engine. The SoA typed arrays live on the definition itself. The per-entity instance records and view bags live on the engine, in `engine.componentStores`.
- **Entity IDs belong to the engine, not to the world.** Two worlds that share an engine share one bitECS ID space. Two worlds with separate engines get independent ID spaces.
- **Entity IDs are runtime-local, and the engine never serialises them.** Identity on the wire uses BelongsTo and UID paths. See `getEntityPath` and `resolveEntityPath`.
- **`AuthoredEvent` is unsigned.** The mutation pipeline in core produces and consumes plain events. Signing and verification are runtime-mode concerns. The `local/` package signs with Ed25519. The `ad4m-bridge/` package delegates to the AD4M executor.
- **The `origin` tag prevents re-broadcast.** A mutation tagged `network`, which means the engine received it from a peer, does not re-enter the outbound queue. Break this and peers echo each other forever. The tests in `packages/core/tests/integration.test.ts` lock it in.
- **Solid signals do not work under the default `node` export condition of Vitest.** Both `local/` and `ad4m-bridge/` hold a `vitest.config.ts` that aliases `solid-js` to its dev build. Copy that config into any new workspace package that pulls Solid in transitively.
- **`pnpm run check` and `pnpm run test` can fail before they start.** pnpm refuses to run when a dependency has an unapproved build script, and reports `ERR_PNPM_IGNORED_BUILDS` instead of a compile error. Run `pnpm approve-builds` once, or pass `--config.verify-deps-before-run=false`.
- **Re-export a module, never a hand-listed subset of its symbols.** `network/peer.ts` used to mirror a fixed list of names from `network/agents.ts`, and the list went stale — `ConnectedTo`, `isPeerConnected`, and `connectedPeers` never reached the public API, and nothing failed to signal it. The barrel in `src/index.ts` exports each module once. A symbol is public when its module is listed there.
- **`Connection` lives in `network/transport.ts`, not `network/network.ts`.** It sits next to `TransportEndpoint` and `RuntimeChannel`, which is what it is made of. `network.ts` imports it for the `Network` interface, so the dependency runs one way.
- **`pnpm build` fails for `local` and `ad4m-bridge` when rollup is absent.** `sh: 1: rollup: not found` is a missing devDependency in the checkout, not a code fault. `core` and `server` build with tsdown and are unaffected.
- **`destroyWorld` clears the pipeline state last.** The descendant sweep calls `removeEntity`, which queues a destroy for each. Clearing first leaves the queue dirty on a world that no longer exists.
- **A destroy needs a local user.** `flushAuthored` checks `world.localUser !== undefined` before it compares owners. Without that check, `undefined === undefined` lets a world with no identity announce the removal of an unowned entity.
- **Tests are typechecked.** Every package tsconfig includes `tests` alongside `src`. Keep it that way: when core excluded tests, four hook assignments that the readonly refactor should have caught at compile time only surfaced as runtime failures.
- **`packages/client` `pnpm test` needs local TLS certs.** Playwright starts the Vite dev server, which reads `.certs/localhost.key`. Without those files the e2e run fails before any test executes. That failure is environmental, not a code regression.
- **A test that leaks a timer or an open handle hangs the whole run.** vitest reports the assertions as passed, then the worker spins at 100% CPU and never exits. If `vitest run` stops producing output while a core stays pegged, look at the file named in the last `stdout |` line rather than at the test that follows it.
