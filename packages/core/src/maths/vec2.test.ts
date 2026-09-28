import { describe, expect, it } from 'vitest'
import { Vec2SoA } from './vec2'

describe('Vec2SoA', () => {
  it('handles AoS and SoA syntax correctly', () => {
    const vectorSoA = new Vec2SoA(Float32Array)
    vectorSoA.resize(2)

    vectorSoA.from(0, [1, 2])
    vectorSoA.from(1, [3, 4])

    const vec0 = vectorSoA.to(0)
    const vec1 = vectorSoA.to(1)

    expect(vec0).toEqual([1, 2])
    expect(vec1).toEqual([3, 4])
  })
})
