import { describe, expect, it } from 'vitest'
import { Vec4SoA } from './vec4'

describe('Vec4SoA', () => {
  it('handles AoS and SoA syntax correctly', () => {
    const vectorSoA = new Vec4SoA(Float32Array)
    vectorSoA.resize(2)

    vectorSoA.from(0, [1, 2, 3, 4])
    vectorSoA.from(1, [5, 6, 7, 8])

    const vec0 = vectorSoA.to(0)
    const vec1 = vectorSoA.to(1)

    expect(vec0).toEqual([1, 2, 3, 4])
    expect(vec1).toEqual([5, 6, 7, 8])
  })
})
