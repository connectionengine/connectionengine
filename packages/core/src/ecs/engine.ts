/**
 * Engine — global runtime container.
 *
 * The Engine owns everything that's truly global to a Connection Engine
 * runtime:
 *
 *   - One bitECS world (`bitECS`). Entity IDs are unique across this engine;
 *     all CE Worlds share this storage and scope themselves via `worldRoot`.
 *   - Component / relation type registries (one definition per `id`,
 *     deduplicated globally).
 *   - Per-component storage (SoA typed arrays + instance maps), indexed by
 *     the engine's global entity IDs.
 *   - The ComponentSchema registry (shareable replication metadata).
 *   - `customRegistries` — slot for higher layers (governance constraint
 *     kinds, peer transport dedup) to store their own engine-keyed state
 *     without ecs/ importing from network/.
 *
 * The default ambient engine is created lazily and is what `defineComponent`
 * / `defineRelation` / `createWorld` use when no engine is passed
 * explicitly. Create a fresh isolated engine with `createEngine()` for
 * plugin sandboxes or test isolation.
 */

import * as bitecs from 'bitecs'
import type { ComponentDefinition, ComponentSchema, PerComponentStores } from './component'
import type { RelationDefinition } from './relation'

export interface Engine {
  /** The shared bitECS world — entity ID space + archetype storage. */
  readonly bitECS: bitecs.World

  /** Component definitions, keyed by `id`. Idempotent on redefinition. */
  readonly components: Map<string, ComponentDefinition>
  /** bitECS ref → ComponentDefinition (for observers / query inspection). */
  readonly componentsByRef: WeakMap<bitecs.ComponentRef, ComponentDefinition>
  /** Per-component engine-level storage (SoA arrays + instance map). */
  readonly componentStores: WeakMap<ComponentDefinition, PerComponentStores>

  /** Relation definitions, keyed by `name`. Idempotent on redefinition. */
  readonly relations: Map<string, RelationDefinition<unknown>>
  /** bitECS relation ref → RelationDefinition. */
  readonly relationsByRef: WeakMap<bitecs.Relation<unknown>, RelationDefinition<unknown>>

  /** Component id → shareable ComponentSchema metadata. */
  readonly schemas: Map<string, ComponentSchema>

  /**
   * Open slot for higher-layer engine-keyed registries — governance constraint
   * kinds, the peer transport dedup table, future plugins. Each owner stamps
   * its own symbol key + typed value. Keeps `ecs/` decoupled from `network/`
   * while still letting the engine be the single root of global state.
   */
  readonly customRegistries: Map<symbol, unknown>
}

/** Create a fresh isolated engine. */
export const createEngine = (): Engine => ({
  bitECS: bitecs.createWorld(),
  components: new Map(),
  componentsByRef: new WeakMap(),
  componentStores: new WeakMap(),
  relations: new Map(),
  relationsByRef: new WeakMap(),
  schemas: new Map(),
  customRegistries: new Map()
})

let _default: Engine | undefined

/**
 * The ambient default engine. Used by all `defineComponent` / `defineRelation`
 * / `createWorld` callers that don't pass an explicit engine. Lazy-initialised
 * on first access.
 */
export const getDefaultEngine = (): Engine => {
  if (!_default) _default = createEngine()
  return _default
}

/**
 * Replace the default engine. Test affordance only — production code should
 * pass an explicit engine to `createWorld` if it needs isolation.
 */
export const setDefaultEngine = (engine: Engine): void => {
  _default = engine
}

/**
 * Helper for higher layers (network/governance, network/peers) to lazily
 * stamp an engine-keyed registry of their own type. `key` is a module-level
 * symbol owned by the caller; `factory` runs once per engine.
 */
export const getOrCreateRegistry = <T>(engine: Engine, key: symbol, factory: () => T): T => {
  const existing = engine.customRegistries.get(key) as T | undefined
  if (existing !== undefined) return existing
  const fresh = factory()
  engine.customRegistries.set(key, fresh as unknown)
  return fresh
}
