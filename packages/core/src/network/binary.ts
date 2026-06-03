/**
 * Schema-driven binary runtime codec — no strings on the wire.
 *
 * **Primary API: `createBinaryPipeline(world, components)`** returns a paired
 * `{ write, read }` codec that share one schema and persistent shadow-map
 * state. Use the pipeline for both sides of any transport — sender calls
 * `.write(metadata, entries)`, receiver calls `.read(buffer, resolveEntity)`.
 *
 * Wire format:
 *
 *   [u32 fromPeerIndex][f64 timestamp][u32 entityCount]
 *   for each entity that wrote:
 *     [u32 networkId][u8/u16/u32 componentMask]
 *     for each set bit in componentMask:
 *       [u8/u16/u32 fieldMask]
 *       for each set bit in fieldMask: typed-array value in its native width
 *
 * Per-component change masks come from the shadow map: floats compared with
 * epsilon tolerance, only changed fields written. An entity with no changes
 * across any component produces zero bytes (rewind kicks in). Force a full
 * send via `pipeline.write(meta, entries, true)` (third arg is
 * `forceFullSync`) or after calling `pipeline.resetShadow()`.
 *
 * Schema is **ordered registration**: both sides agree out-of-band on the
 * component order (handshake responsibility). Position in the array = wire
 * index.
 *
 * Components must be stored per-world (typed arrays allocated lazily on
 * `setComponent`); the codec resolves to the world's SoA stores via `getSoA`
 * and keys its shadow map on typed-array identity, so different worlds
 * naturally have independent change-tracking state.
 *
 * Authored events use a separate string-shaped codec in `engine/codec.ts`
 * (low-frequency, value-JSON-dominated payload).
 */

import type { TypedArray } from '../maths/common'
import type { ComponentDefinition } from '../ecs/component'
import { getSoA } from '../ecs/component'
import type { World } from '../ecs/world'
import {
  type ViewCursor,
  checkBitflag,
  clearShadowMap,
  createViewCursor,
  readFloat64,
  readPropInto,
  readUint32,
  readUint8,
  readUint16,
  rewindViewCursor,
  sliceViewCursor,
  spaceUint16,
  spaceUint32,
  spaceUint8,
  writeFloat64,
  writePropIfChanged,
  writeUint32
} from './cursor'

// ── Internal: flatten SoA + mask helpers ─────────────────────────────────────-

/**
 * Walk a per-world `$soa` record and yield a flat ordered list of every leaf
 * TypedArray. For `{ position: Vec3SoA, rotation: QuatSoA }` we yield
 * `[position.x, .y, .z, rotation.x, .y, .z, .w]`.
 *
 * Cache keyed on (world, component) — per-world stores are independent typed
 * arrays.
 */
const flattenCachePerWorld = new WeakMap<World, WeakMap<ComponentDefinition, readonly TypedArray[]>>()

const flattenSoA = (world: World, component: ComponentDefinition): readonly TypedArray[] => {
  let perWorld = flattenCachePerWorld.get(world)
  if (!perWorld) {
    perWorld = new WeakMap()
    flattenCachePerWorld.set(world, perWorld)
  }
  const cached = perWorld.get(component)
  if (cached) return cached
  const soa = getSoA(world, component)
  const out: TypedArray[] = []
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    if (ArrayBuffer.isView(node) && !(node instanceof DataView)) {
      out.push(node as TypedArray)
      return
    }
    for (const key of Object.keys(node as Record<string, unknown>)) {
      if (key.startsWith('_')) continue
      const child = (node as Record<string, unknown>)[key]
      if (typeof child === 'function') continue
      walk(child)
    }
  }
  walk(soa)
  Object.freeze(out)
  perWorld.set(component, out)
  return out
}

const maskWidthFor = (propCount: number): 1 | 2 | 4 => {
  if (propCount <= 8) return 1
  if (propCount <= 16) return 2
  if (propCount <= 32) return 4
  throw new Error(`binary: components with >32 leaf props not supported (got ${propCount})`)
}

const spaceFor = (width: 1 | 2 | 4) => (width === 1 ? spaceUint8 : width === 2 ? spaceUint16 : spaceUint32)
const readMaskOf = (width: 1 | 2 | 4) => (width === 1 ? readUint8 : width === 2 ? readUint16 : readUint32)

// ── Per-component write/read primitives ──────────────────────────────────────-

const writeComponent = (
  world: World,
  component: ComponentDefinition,
  view: ViewCursor,
  entity: number,
  forceFullSync: boolean
): boolean => {
  const props = flattenSoA(world, component)
  if (props.length === 0) return false
  const width = maskWidthFor(props.length)
  const rewind = rewindViewCursor(view)
  const writeMask = spaceFor(width)(view)
  let mask = 0
  for (let i = 0; i < props.length; i++) {
    if (writePropIfChanged(view, props[i], entity, forceFullSync)) mask |= 1 << i
  }
  if (mask === 0) {
    rewind()
    return false
  }
  writeMask(mask)
  return true
}

const readComponent = (world: World, component: ComponentDefinition, view: ViewCursor, entity: number): void => {
  const props = flattenSoA(world, component)
  const width = maskWidthFor(props.length)
  const mask = readMaskOf(width)(view)
  for (let i = 0; i < props.length; i++) {
    if (checkBitflag(mask, i)) readPropInto(view, props[i], entity)
  }
}

// ── Public types ─────────────────────────────────────────────────────────────-

export interface BinaryPacketMetadata {
  fromPeerIndex: number
  timestamp: number
}

export interface BinaryPacketHeader extends BinaryPacketMetadata {
  entityCount: number
}

export interface BinaryEntry {
  networkId: number
  entity: number
}

export interface BinaryPipeline {
  /**
   * Encode the given entities into a binary packet. The shadow map persists
   * across calls so only changed fields are emitted; pass `forceFullSync: true`
   * to emit a full snapshot regardless of diff.
   *
   * The returned `ArrayBuffer` is a fresh slice of the writer's internal
   * cursor — safe to send over a wire transport without copying.
   */
  write(metadata: BinaryPacketMetadata, entries: readonly BinaryEntry[], forceFullSync?: boolean): ArrayBuffer

  /**
   * Decode a binary packet and apply its entity updates to this world.
   * `resolveEntity` maps incoming `networkId` to a local entity (typically
   * via a `Map<networkId, Entity>` maintained by the transport layer); if a
   * networkId is unknown, the component blocks are still parsed and
   * discarded so the stream stays in sync.
   *
   * Returns the packet header for the caller to inspect (peer index +
   * timestamp + entity count).
   */
  read(buffer: ArrayBuffer, resolveEntity: (networkId: number) => number | undefined): BinaryPacketHeader

  /**
   * Forget all shadowed values. The next `write` call will emit a full
   * snapshot for every entity it touches. Use this after a peer disconnects +
   * reconnects, or on a periodic full-sync tick.
   */
  resetShadow(): void

  /** Ordered list of components in this pipeline (position = wire index). */
  readonly components: readonly ComponentDefinition[]
}

// ── createBinaryPipeline ─────────────────────────────────────────────────────-

export interface CreateBinaryPipelineOptions {
  /** Initial buffer size for the writer's cursor. Grows on demand. Default 100 KiB. */
  bufferBytes?: number
}

/**
 * Build a paired binary codec for a fixed set of components on a world.
 *
 * The same pipeline owns both `.write` (encoder, with persistent shadow map)
 * and `.read` (decoder). Use the same pipeline factory on both sides of a
 * transport — the only out-of-band agreement required is the component order
 * passed here. Component IDs are not on the wire; position is.
 *
 *   const pipe = createBinaryPipeline(world, [Transform, Velocity])
 *   const buf  = pipe.write({ fromPeerIndex: 7, timestamp: world.clock.now() }, dirtyEntries)
 *   // ... on receiver:
 *   const peerPipe = createBinaryPipeline(peerWorld, [Transform, Velocity])
 *   peerPipe.read(buf, (nid) => entityMap.get(nid))
 */
export const createBinaryPipeline = (
  world: World,
  components: readonly ComponentDefinition[],
  options: CreateBinaryPipelineOptions = {}
): BinaryPipeline => {
  if (components.length === 0) throw new Error('createBinaryPipeline requires at least one component')
  const entityMaskWidth = maskWidthFor(components.length)
  const writerView = createViewCursor(new ArrayBuffer(options.bufferBytes ?? 100_000))

  const writeEntityBlock = (view: ViewCursor, entry: BinaryEntry, forceFullSync: boolean): boolean => {
    const rewind = rewindViewCursor(view)
    writeUint32(view, entry.networkId)
    const writeEntityMask = spaceFor(entityMaskWidth)(view)
    let mask = 0
    for (let i = 0; i < components.length; i++) {
      if (writeComponent(world, components[i], view, entry.entity, forceFullSync)) mask |= 1 << i
    }
    if (mask === 0) {
      rewind()
      return false
    }
    writeEntityMask(mask)
    return true
  }

  const readEntityBlock = (view: ViewCursor, resolveEntity: (nid: number) => number | undefined): void => {
    const networkId = readUint32(view)
    const entityMask = readMaskOf(entityMaskWidth)(view)
    const entity = resolveEntity(networkId)
    for (let i = 0; i < components.length; i++) {
      if (!checkBitflag(entityMask, i)) continue
      readComponent(world, components[i], view, entity ?? 0)
    }
  }

  return {
    components,

    write(metadata, entries, forceFullSync = false) {
      writeUint32(writerView, metadata.fromPeerIndex)
      writeFloat64(writerView, metadata.timestamp)
      const reserveCount = spaceUint32(writerView)
      let count = 0
      for (const entry of entries) {
        if (writeEntityBlock(writerView, entry, forceFullSync)) count++
      }
      reserveCount(count)
      return sliceViewCursor(writerView)
    },

    read(buffer, resolveEntity) {
      const view = createViewCursor(buffer)
      const header: BinaryPacketHeader = {
        fromPeerIndex: readUint32(view),
        timestamp: readFloat64(view),
        entityCount: readUint32(view)
      }
      for (let i = 0; i < header.entityCount; i++) {
        readEntityBlock(view, resolveEntity)
      }
      return header
    },

    resetShadow() {
      clearShadowMap(writerView)
    }
  }
}
