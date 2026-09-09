import { describe, expect, it } from 'vitest'
import { Schema } from '../schema'
import { createEngine } from '../ecs/engine'
import { createAnonAgent, createWorld, destroyWorld } from '../ecs/world'
import { createEntity } from '../ecs/entity'
import { defineComponent, setComponent } from '../ecs/component'
import { addRelation, defineRelation } from '../ecs/relation'
import { Not, Or, query } from './query'
import { Wildcard } from '../ecs/relation'

const A = defineComponent({ id: 'A', schema: Schema.Object({ v: Schema.Number({ default: 0 }) }) })
const B = defineComponent({ id: 'B', schema: Schema.Object({ v: Schema.Number({ default: 0 }) }) })

const ChildOf = defineRelation({ name: 'ChildOf', exclusive: true })

describe('Query', () => {
  it('returns entities matching all components', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const e1 = createEntity(world)
    const e2 = createEntity(world)
    const e3 = createEntity(world)
    setComponent(world, e1, A)
    setComponent(world, e2, A)
    setComponent(world, e2, B)
    setComponent(world, e3, B)
    const ab = Array.from(query(world, [A, B]))
    expect(ab).toEqual([e2])
    const onlyA = Array.from(query(world, [A]))
    expect(onlyA.sort()).toEqual([e1, e2].sort())
    destroyWorld(world)
  })

  it('Or matches union of component sets', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const e1 = createEntity(world)
    const e2 = createEntity(world)
    const e3 = createEntity(world)
    setComponent(world, e1, A)
    setComponent(world, e3, B)
    const orAB = Array.from(query(world, [Or(A, B)]))
    expect(orAB.sort()).toEqual([e1, e3].sort())
    expect(orAB).not.toContain(e2)
    destroyWorld(world)
  })

  it('Not excludes', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const e1 = createEntity(world)
    const e2 = createEntity(world)
    setComponent(world, e1, A)
    setComponent(world, e2, A)
    setComponent(world, e2, B)
    const aNotB = Array.from(query(world, [A, Not(B)]))
    expect(aNotB).toEqual([e1])
    destroyWorld(world)
  })

  it('relation queries match children of a parent', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const parent = createEntity(world)
    const c1 = createEntity(world)
    const c2 = createEntity(world)
    const other = createEntity(world)
    addRelation(world, c1, ChildOf, parent)
    addRelation(world, c2, ChildOf, parent)
    setComponent(world, other, A)
    const children = Array.from(query(world, [ChildOf.$relation(parent)]))
    expect(children.sort()).toEqual([c1, c2].sort())
    destroyWorld(world)
  })

  it('wildcard relation matches any target', () => {
    const world = createWorld({ engine: createEngine(), agent: createAnonAgent() })
    const p1 = createEntity(world)
    const p2 = createEntity(world)
    const c1 = createEntity(world)
    const c2 = createEntity(world)
    addRelation(world, c1, ChildOf, p1)
    addRelation(world, c2, ChildOf, p2)
    const anyChild = Array.from(query(world, [ChildOf.$relation(Wildcard)]))
    expect(anyChild.sort()).toEqual([c1, c2].sort())
    destroyWorld(world)
  })
})
