import { describe, expect, it } from 'vitest'
import { Quat2SoA } from './quat2'

describe('Quat2SoA', () => {
  it('handles AoS and SoA syntax correctly', () => {
    const quat2SoA = new Quat2SoA(Float32Array)
    quat2SoA.resize(2)

    quat2SoA.from(0, [1, 2, 3, 4, 5, 6, 7, 8])
    quat2SoA.from(1, [9, 10, 11, 12, 13, 14, 15, 16])

    const q0 = quat2SoA.to(0)
    const q1 = quat2SoA.to(1)

    expect(q0).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(q1).toEqual([9, 10, 11, 12, 13, 14, 15, 16])
  })
})
