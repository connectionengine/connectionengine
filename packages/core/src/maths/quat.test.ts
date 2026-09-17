import { describe, expect, it } from 'vitest'
import { QuatSoA } from './quat'

describe('QuatSoA', () => {
  it('handles AoS and SoA syntax correctly', () => {
    const quatSoA = new QuatSoA(Float32Array)
    quatSoA.resize(2)

    quatSoA.from(0, [1, 2, 3, 4])
    quatSoA.from(1, [5, 6, 7, 8])

    const q0 = quatSoA.to(0)
    const q1 = quatSoA.to(1)

    expect(q0).toEqual([1, 2, 3, 4])
    expect(q1).toEqual([5, 6, 7, 8])
  })
})
