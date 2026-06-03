/**
 * Schema-driven binary runtime codec — no strings on the wire.
 *
 * **Primary API: `createBinaryPipeline(world, components, options?)`** returns
 * a paired `{ write, read }` codec that share one schema and persistent
 * shadow-map state. Use the pipeline for both sides of any transport —
 * sender calls `.write(metadata, entries)`, receiver calls
 * `.read(buffer, resolveEntity)`.
 *
 * Wire format:
 *
 *   [u32 fromPeerIndex][f64 timestamp][u32 entityCount]
 *   for each entity that wrote:
 *     [u32 networkId][u8/u16/u32 componentMask]
 *     for each set bit in componentMask:
 *       [u8/u16/u32 propMask]
 *       for each set bit in propMask: prop payload (raw or compressed)
 *
 * Per-prop change masks come from the shadow map: floats compared with epsilon
 * tolerance, only changed props written. An entity with no changes across any
 * component produces zero bytes (rewind kicks in). Force a full send via
 * `pipeline.write(meta, entries, true)` or after `pipeline.resetShadow()`.
 *
 * Optional per-field compression — `Vec3 → 3 × int16`, `Quat → smallest-three`
 * — is opt-in via the `compression` option (see `compression.ts` and the
 * `Prop` discriminator below). Compressed fields collapse multi-axis groups
 * into single props with single mask bits.
 *
 * Schema is **ordered registration**: both sides agree out-of-band on the
 * component order (handshake responsibility). Position in the array = wire
 * index.
 *
 * Authored events use a separate string-shaped codec in `codec.ts`
 * (low-frequency, value-JSON-dominated payload).
 */

import type { TypedArray } from '../maths/common'
import type { ComponentDefinition } from '../ecs/component'
import { hasComponent, setComponent } from '../ecs/component'
import type { World } from '../ecs/world'
import {
  type ViewCursor,
  checkBitflag,
  clearShadowMap,
  commitPropShadow,
  createViewCursor,
  isPropChanged,
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
import type { CompressionConfig, FieldCompressionSpec } from './compression'
import {
  decodeQuatSmallest3,
  decodeVec3Int16,
  encodeQuatSmallest3,
  encodeVec3Int16,
  QUAT_SMALLEST3_BYTES,
  VEC3_INT16_BYTES
} from './compression'

// ── Prop model ───────────────────────────────────────────────────────────────-

/**
 * A logical wire slot for one component. Either a single typed array OR a
 * grouped + compressed multi-axis field (Vec3, Quat). Change masks index by
 * Prop position, not by underlying typed array.
 */
type Prop =
  | { kind: 'raw'; array: TypedArray }
  | { kind: 'vec3-int16'; x: TypedArray; y: TypedArray; z: TypedArray; range: number }
  | { kind: 'quat-smallest3'; x: TypedArray; y: TypedArray; z: TypedArray; w: TypedArray }

// ── flattenProps — per-world + per-compression-spec cache ────────────────────-

const propsCache = new WeakMap<World, WeakMap<ComponentDefinition, Map<string, readonly Prop[]>>>()

const cacheKey = (spec: Record<string, FieldCompressionSpec> | undefined): string => (spec ? JSON.stringify(spec) : '_')

const flattenProps = (
  world: World,
  component: ComponentDefinition,
  compressionForComponent: Record<string, FieldCompressionSpec> | undefined
): readonly Prop[] => {
  let perWorld = propsCache.get(world)
  if (!perWorld) {
    perWorld = new WeakMap()
    propsCache.set(world, perWorld)
  }
  let perComponent = perWorld.get(component)
  if (!perComponent) {
    perComponent = new Map()
    perWorld.set(component, perComponent)
  }
  const key = cacheKey(compressionForComponent)
  const cached = perComponent.get(key)
  if (cached) return cached
  const out: Prop[] = []
  const append = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    if (ArrayBuffer.isView(node) && !(node instanceof DataView)) {
      out.push({ kind: 'raw', array: node as TypedArray })
      return
    }
    for (const key of Object.keys(node as Record<string, unknown>)) {
      if (key.startsWith('_')) continue
      const child = (node as Record<string, unknown>)[key]
      if (typeof child === 'function') continue
      append(child)
    }
  }
  for (const fieldName of component.$soaFields) {
    const field = component[fieldName]
    const spec = compressionForComponent?.[fieldName]
    if (spec && isVec3SoA(field)) {
      out.push({
        kind: 'vec3-int16',
        x: field.x,
        y: field.y,
        z: field.z,
        range: (spec as { range: number }).range
      })
      continue
    }
    if (spec && isQuatSoA(field)) {
      out.push({ kind: 'quat-smallest3', x: field.x, y: field.y, z: field.z, w: field.w })
      continue
    }
    append(field)
  }
  Object.freeze(out)
  perComponent.set(key, out)
  return out
}

const isVec3SoA = (v: unknown): v is { x: TypedArray; y: TypedArray; z: TypedArray } =>
  !!v &&
  typeof v === 'object' &&
  ArrayBuffer.isView((v as { x?: unknown }).x) &&
  ArrayBuffer.isView((v as { y?: unknown }).y) &&
  ArrayBuffer.isView((v as { z?: unknown }).z) &&
  !ArrayBuffer.isView((v as { w?: unknown }).w)

const isQuatSoA = (v: unknown): v is { x: TypedArray; y: TypedArray; z: TypedArray; w: TypedArray } =>
  !!v &&
  typeof v === 'object' &&
  ArrayBuffer.isView((v as { x?: unknown }).x) &&
  ArrayBuffer.isView((v as { y?: unknown }).y) &&
  ArrayBuffer.isView((v as { z?: unknown }).z) &&
  ArrayBuffer.isView((v as { w?: unknown }).w)

// ── Mask helpers ─────────────────────────────────────────────────────────────-

const maskWidthFor = (propCount: number): 1 | 2 | 4 => {
  if (propCount <= 8) return 1
  if (propCount <= 16) return 2
  if (propCount <= 32) return 4
  throw new Error(`binary: components with >32 logical props not supported (got ${propCount})`)
}

const spaceFor = (width: 1 | 2 | 4) => (width === 1 ? spaceUint8 : width === 2 ? spaceUint16 : spaceUint32)
const readMaskOf = (width: 1 | 2 | 4) => (width === 1 ? readUint8 : width === 2 ? readUint16 : readUint32)

// ── Per-prop write/read ──────────────────────────────────────────────────────-

/**
 * Write one prop iff it has changed since the last shadowed value. Returns
 * whether a write happened. For grouped (compressed) props, "changed" means
 * any of the underlying typed arrays differs from its shadow — we test
 * non-destructively, then if any changed write the packed payload + commit
 * shadow for all axes.
 */
const writeProp = (view: ViewCursor, prop: Prop, entity: number, forceFullSync: boolean): boolean => {
  if (prop.kind === 'raw') return writePropIfChanged(view, prop.array, entity, forceFullSync)
  if (prop.kind === 'vec3-int16') {
    const changed =
      forceFullSync ||
      isPropChanged(view, prop.x, entity) ||
      isPropChanged(view, prop.y, entity) ||
      isPropChanged(view, prop.z, entity)
    if (!changed) return false
    const xv = readArray(prop.x, entity, 0)
    const yv = readArray(prop.y, entity, 0)
    const zv = readArray(prop.z, entity, 0)
    encodeVec3Int16(view, xv, yv, zv, prop.range)
    commitPropShadow(view, prop.x, entity)
    commitPropShadow(view, prop.y, entity)
    commitPropShadow(view, prop.z, entity)
    return true
  }
  // quat-smallest3
  const changed =
    forceFullSync ||
    isPropChanged(view, prop.x, entity) ||
    isPropChanged(view, prop.y, entity) ||
    isPropChanged(view, prop.z, entity) ||
    isPropChanged(view, prop.w, entity)
  if (!changed) return false
  const xv = readArray(prop.x, entity, 0)
  const yv = readArray(prop.y, entity, 0)
  const zv = readArray(prop.z, entity, 0)
  const wv = readArray(prop.w, entity, 1)
  encodeQuatSmallest3(view, xv, yv, zv, wv)
  commitPropShadow(view, prop.x, entity)
  commitPropShadow(view, prop.y, entity)
  commitPropShadow(view, prop.z, entity)
  commitPropShadow(view, prop.w, entity)
  return true
}

const readArray = (array: TypedArray, entity: number, fallback: number): number => {
  const v = (array as unknown as Record<number, number>)[entity]
  return v === undefined || Number.isNaN(v) ? fallback : v
}

const readProp = (view: ViewCursor, prop: Prop, entity: number): void => {
  if (prop.kind === 'raw') {
    readPropInto(view, prop.array, entity)
    return
  }
  if (prop.kind === 'vec3-int16') {
    const [x, y, z] = decodeVec3Int16(view, prop.range)
    writeIntoArray(prop.x, entity, x)
    writeIntoArray(prop.y, entity, y)
    writeIntoArray(prop.z, entity, z)
    return
  }
  const [x, y, z, w] = decodeQuatSmallest3(view)
  writeIntoArray(prop.x, entity, x)
  writeIntoArray(prop.y, entity, y)
  writeIntoArray(prop.z, entity, z)
  writeIntoArray(prop.w, entity, w)
}

const writeIntoArray = (array: TypedArray, entity: number, value: number): void => {
  if (entity >= array.length) {
    const resizable = array as TypedArray & { resize?: (n: number) => void }
    if (typeof resizable.resize === 'function') resizable.resize(entity + 1)
  }
  ;(array as unknown as Record<number, number>)[entity] = value
}

// ── Per-component write/read ─────────────────────────────────────────────────-

const writeComponent = (
  world: World,
  component: ComponentDefinition,
  view: ViewCursor,
  entity: number,
  forceFullSync: boolean,
  compressionForComponent: Record<string, FieldCompressionSpec> | undefined
): boolean => {
  const props = flattenProps(world, component, compressionForComponent)
  if (props.length === 0) return false
  const width = maskWidthFor(props.length)
  const rewind = rewindViewCursor(view)
  const writeMask = spaceFor(width)(view)
  let mask = 0
  for (let i = 0; i < props.length; i++) {
    if (writeProp(view, props[i], entity, forceFullSync)) mask |= 1 << i
  }
  if (mask === 0) {
    rewind()
    return false
  }
  writeMask(mask)
  return true
}

const readComponent = (
  world: World,
  component: ComponentDefinition,
  view: ViewCursor,
  entity: number,
  compressionForComponent: Record<string, FieldCompressionSpec> | undefined
): void => {
  // Ensure the component is present on the entity. Without this, the SoA store
  // values are written but `hasComponent` returns false and `getComponent`
  // returns undefined.
  if (entity !== 0 && !hasComponent(world, entity, component)) {
    setComponent(world, entity, component, {}, { origin: 'network' })
  }
  const props = flattenProps(world, component, compressionForComponent)
  const width = maskWidthFor(props.length)
  const mask = readMaskOf(width)(view)
  for (let i = 0; i < props.length; i++) {
    if (checkBitflag(mask, i)) readProp(view, props[i], entity)
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
  write(metadata: BinaryPacketMetadata, entries: readonly BinaryEntry[], forceFullSync?: boolean): ArrayBuffer
  read(buffer: ArrayBuffer, resolveEntity: (networkId: number) => number | undefined): BinaryPacketHeader
  resetShadow(): void
  readonly components: readonly ComponentDefinition[]
}

export interface CreateBinaryPipelineOptions {
  /** Initial buffer size for the writer's cursor. Grows on demand. Default 100 KiB. */
  bufferBytes?: number
  /** Per-component-id → per-field compression spec. Opt-in. */
  compression?: CompressionConfig
}

export const createBinaryPipeline = (
  world: World,
  components: readonly ComponentDefinition[],
  options: CreateBinaryPipelineOptions = {}
): BinaryPipeline => {
  if (components.length === 0) throw new Error('createBinaryPipeline requires at least one component')
  const entityMaskWidth = maskWidthFor(components.length)
  const writerView = createViewCursor(new ArrayBuffer(options.bufferBytes ?? 100_000))
  const compression = options.compression ?? {}

  const writeEntityBlock = (view: ViewCursor, entry: BinaryEntry, forceFullSync: boolean): boolean => {
    const rewind = rewindViewCursor(view)
    writeUint32(view, entry.networkId)
    const writeEntityMask = spaceFor(entityMaskWidth)(view)
    let mask = 0
    for (let i = 0; i < components.length; i++) {
      const componentCompression = compression[components[i].$id]
      if (writeComponent(world, components[i], view, entry.entity, forceFullSync, componentCompression)) {
        mask |= 1 << i
      }
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
      readComponent(world, components[i], view, entity ?? 0, compression[components[i].$id])
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

// Re-export for external use
export type { CompressionConfig, FieldCompressionSpec, Vec3Int16Spec, QuatSmallest3Spec } from './compression'
export { VEC3_INT16_BYTES, QUAT_SMALLEST3_BYTES }
