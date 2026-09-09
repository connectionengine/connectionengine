/**
 * Replication contract for a component carrying both SoA-tagged (continuous)
 * and value-typed (discrete) fields — the case where both sides of one rule are
 * visible at once:
 *
 *   Existence is governed. Values are governed only where they are discrete.
 *
 * Concretely — an authored event is the only thing that may create or remove a
 * component, and it carries the whole component so governance can inspect the
 * initial continuous state too. Binary deltas may only *modify* something that
 * already exists. They can never bring it into being. That is what stops the
 * ungoverned fast path from resurrecting a write governance refused.
 */

import { describe, expect, it } from 'vitest'
import { Schema } from '../schema'
import { createAnonAgent, createWorld, destroyWorld, type World } from '../ecs/world'
import { createEngine } from '../ecs/engine'
import { createEntity, getEntityByUID, setUID } from '../ecs/entity'
import { defineComponent, getComponent, hasComponent, removeComponent, setComponent } from '../ecs/component'
import { createBinaryPipeline } from './binary'
import { applyAuthoredEnvelope, flushAuthored } from './mutation'
import { ensureDefaultNetwork } from './network'
import { applySnapshot, createSnapshot } from './snapshot'

/** Governed existence + discrete `label`, ungoverned continuous `position`. */
const Body = defineComponent({
  id: 'MX.Body',
  schema: Schema.Object({
    position: Schema.Vec3(),
    label: Schema.String({ default: '' })
  })
})

/** Pure-continuous control — governed on existence, free on value. */
const Velocity = defineComponent({
  id: 'MX.Velocity',
  schema: Schema.Object({ linear: Schema.Vec3() })
})

const mkWorld = (name: string): World => createWorld({ engine: createEngine(), agent: createAnonAgent(name) })

describe('mixed-channel — the authored half carries the whole component', () => {
  it('the wire event carries both halves, and applying it reconstructs both', () => {
    const source = mkWorld('mx-src')
    const target = mkWorld('mx-tgt')

    const e = createEntity(source)
    setUID(source, e, 'rock')
    setComponent(source, e, Body, { position: [1, 2, 3], label: 'rock' })
    const envelope = flushAuthored(source)!

    const setEvent = envelope.events.find((ev) => ev.predicate === 'MX.Body' && ev.op === 'set')!
    expect(setEvent.value).toEqual({ position: [1, 2, 3], label: 'rock' })

    applyAuthoredEnvelope(target, envelope)
    const te = named(target, 'rock')
    expect(hasComponent(target, te, Body)).toBe(true)
    const body = getComponent(target, te, Body)
    expect(body?.label).toBe('rock')
    expect(body?.position.x).toBeCloseTo(1)
    expect(body?.position.z).toBeCloseTo(3)

    destroyWorld(source)
    destroyWorld(target)
  })

  it('the whole-component value survives a serialisation round-trip', () => {
    const source = mkWorld('mx-codec-src')
    const target = mkWorld('mx-codec-tgt')

    const e = createEntity(source)
    setUID(source, e, 'rock')
    setComponent(source, e, Body, { position: [1.5, -2, 3], label: 'rock' })
    const envelope = flushAuthored(source)!

    // The authored value carries SoA fields as plain arrays. A real transport
    // serialises the envelope, so the value has to survive that and not only
    // the in-process path where both sides share one object.
    const decoded = JSON.parse(JSON.stringify(envelope)) as typeof envelope
    applyAuthoredEnvelope(target, decoded)

    const body = getComponent(target, named(target, 'rock'), Body)
    expect(body?.label).toBe('rock')
    expect(body?.position.x).toBeCloseTo(1.5)
    expect(body?.position.y).toBeCloseTo(-2)

    destroyWorld(source)
    destroyWorld(target)
  })

  it('an authored remove takes both halves', () => {
    const source = mkWorld('mx-rm-src')
    const target = mkWorld('mx-rm-tgt')

    const e = createEntity(source)
    setUID(source, e, 'rock')
    setComponent(source, e, Body, { position: [1, 2, 3], label: 'rock' })
    applyAuthoredEnvelope(target, flushAuthored(source)!)
    const te = named(target, 'rock')
    expect(hasComponent(target, te, Body)).toBe(true)

    setComponent(source, e, Body, { label: 'gone' })
    flushAuthored(source)
    removeComponentViaWire(source, target, e)
    expect(hasComponent(target, te, Body)).toBe(false)

    destroyWorld(source)
    destroyWorld(target)
  })
})

describe('mixed-channel — a delta may not create a governed component', () => {
  it('a delta for an absent mixed component is discarded, not auto-added', () => {
    const source = mkWorld('mx-nocreate-src')
    const target = mkWorld('mx-nocreate-tgt')

    const sourcePipe = createBinaryPipeline(source, [Body])
    const targetPipe = createBinaryPipeline(target, [Body])

    const e = createEntity(source)
    setComponent(source, e, Body, { position: [7, 8, 9], label: 'rock' })
    const buf = sourcePipe.write({ timestamp: 1 }, [{ networkId: 1, entity: e }])

    // Target entity exists but was never granted the component by an authored
    // event — the delta must not conjure it into existence.
    const te = createEntity(target)
    targetPipe.read(buf, () => te)

    expect(hasComponent(target, te, Body)).toBe(false)

    destroyWorld(source)
    destroyWorld(target)
  })

  it('discarding one component still decodes the rest of the packet', () => {
    // Velocity is pre-created on the target so it can receive. Body
    // is not, so it must be skipped without corrupting the read cursor.
    const source = mkWorld('mx-cursor-src')
    const target = mkWorld('mx-cursor-tgt')

    const sourcePipe = createBinaryPipeline(source, [Body, Velocity])
    const targetPipe = createBinaryPipeline(target, [Body, Velocity])

    const e = createEntity(source)
    setComponent(source, e, Body, { position: [7, 8, 9], label: 'rock' })
    setComponent(source, e, Velocity, { linear: [0.5, 0.25, 0.125] })
    const buf = sourcePipe.write({ timestamp: 1 }, [{ networkId: 1, entity: e }])

    const te = createEntity(target)
    setComponent(target, te, Velocity, {}, { origin: 'network' })
    targetPipe.read(buf, () => te)

    // Body was skipped. Velocity still applied, which is only possible if the
    // skipped component's bytes were consumed.
    expect(hasComponent(target, te, Body)).toBe(false)
    expect(getComponent(target, te, Velocity)?.linear.x).toBeCloseTo(0.5)

    destroyWorld(source)
    destroyWorld(target)
  })

  it('once the authored event has created it, deltas apply normally', () => {
    const source = mkWorld('mx-then-src')
    const target = mkWorld('mx-then-tgt')

    const e = createEntity(source)
    setUID(source, e, 'rock')
    setComponent(source, e, Body, { position: [1, 1, 1], label: 'rock' })
    applyAuthoredEnvelope(target, flushAuthored(source)!)
    const te = named(target, 'rock')
    expect(hasComponent(target, te, Body)).toBe(true)

    const sourcePipe = createBinaryPipeline(source, [Body])
    const targetPipe = createBinaryPipeline(target, [Body])
    setComponent(source, e, Body, { position: [4, 5, 6] })
    const buf = sourcePipe.write({ timestamp: 2 }, [{ networkId: 1, entity: e }])
    targetPipe.read(buf, () => te)

    expect(getComponent(target, te, Body)?.position.x).toBeCloseTo(4)
    expect(getComponent(target, te, Body)?.position.z).toBeCloseTo(6)
    // The discrete half is untouched by the delta.
    expect(getComponent(target, te, Body)?.label).toBe('rock')

    destroyWorld(source)
    destroyWorld(target)
  })

  it('no component is auto-created by a delta, not even a pure-continuous one', () => {
    const source = mkWorld('mx-pure-src')
    const target = mkWorld('mx-pure-tgt')

    const sourcePipe = createBinaryPipeline(source, [Velocity])
    const targetPipe = createBinaryPipeline(target, [Velocity])

    const e = createEntity(source)
    setUID(source, e, 'mover')
    setComponent(source, e, Velocity, { linear: [1, 2, 3] })
    const buf = sourcePipe.write({ timestamp: 1 }, [{ networkId: 1, entity: e }])

    const te = createEntity(target)
    targetPipe.read(buf, () => te)
    expect(hasComponent(target, te, Velocity)).toBe(false)

    // Its existence arrives on the authored channel instead — carrying the
    // pose it was created with — and deltas apply from then on.
    applyAuthoredEnvelope(target, flushAuthored(source)!)
    const named1 = named(target, 'mover')
    expect(getComponent(target, named1, Velocity)?.linear.y).toBeCloseTo(2)

    destroyWorld(source)
    destroyWorld(target)
  })
})

describe('mixed-channel — governance holds', () => {
  it('a refused creation cannot be resurrected by a delta', () => {
    const source = mkWorld('mx-gov-src')
    const target = mkWorld('mx-gov-tgt')

    // Target refuses every write to MX.Body.
    const network = ensureDefaultNetwork(target, {
      onValidateAuthored: (_w, _n, event) => event.predicate !== 'MX.Body'
    })

    const e = createEntity(source)
    setUID(source, e, 'rock')
    setComponent(source, e, Body, { position: [1, 2, 3], label: 'contraband' })
    applyAuthoredEnvelope(target, flushAuthored(source)!, network)

    const te = named(target, 'rock')
    expect(hasComponent(target, te, Body)).toBe(false)

    // The ungoverned fast path must not be able to smuggle it back in.
    const sourcePipe = createBinaryPipeline(source, [Body])
    const targetPipe = createBinaryPipeline(target, [Body])
    const buf = sourcePipe.write({ timestamp: 2 }, [{ networkId: 1, entity: e }])
    targetPipe.read(buf, () => te)

    expect(hasComponent(target, te, Body)).toBe(false)

    destroyWorld(source)
    destroyWorld(target)
  })
})

describe('mixed-channel — snapshot', () => {
  it('round-trips both halves of a mixed component', () => {
    const source = mkWorld('mx-snap-src')
    const target = mkWorld('mx-snap-tgt')

    const e = createEntity(source)
    setUID(source, e, 'rock')
    setComponent(source, e, Body, { position: [1.5, 2.5, 3.5], label: 'rock' })

    applySnapshot(target, createSnapshot(source))

    const te = named(target, 'rock')
    const body = getComponent(target, te, Body)
    expect(body?.label).toBe('rock')
    expect(body?.position.x).toBeCloseTo(1.5)
    expect(body?.position.y).toBeCloseTo(2.5)
    expect(body?.position.z).toBeCloseTo(3.5)

    destroyWorld(source)
    destroyWorld(target)
  })
})

// ── helpers ───────────────────────────────────────────────────────────────────

/** Resolve a top-level named entity, failing loudly if absent. */
const named = (world: World, uid: string): number => {
  const e = getEntityByUID(world, world.worldRoot, uid)
  if (e === undefined) throw new Error(`no entity '${uid}'`)
  return e
}

/** Author a removal on `source` and apply the resulting envelope to `target`. */
const removeComponentViaWire = (source: World, target: World, entity: number): void => {
  removeComponent(source, entity, Body)
  const envelope = flushAuthored(source)
  if (envelope) applyAuthoredEnvelope(target, envelope)
}
