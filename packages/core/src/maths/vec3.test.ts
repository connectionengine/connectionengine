import { describe, expect, it } from 'vitest'
import { Vec3SoA } from './vec3'

describe('Vec3SoA', () => {
  it('handles AoS and SoA syntax correctly', () => {
    // Original example code adapted to test
    const positionSoA = new Vec3SoA(Float32Array)
    positionSoA.resize(2)

    // Using from() to set values
    positionSoA.from(0, [1, 2, 3])
    positionSoA.from(1, [4, 5, 6])

    // Using to() to get values
    const pos0 = positionSoA.to(0)
    const pos1 = positionSoA.to(1)

    expect(pos0).toEqual([1, 2, 3])
    expect(pos1).toEqual([4, 5, 6])
  })
})
