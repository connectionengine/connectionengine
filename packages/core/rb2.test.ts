import { describe, expect, it } from 'vitest'
import { createPeerMesh } from './tests/test-utils/peer-pair'
import { spawnPrefab } from './src/network/prefab'
import { findUserByDID } from './src/network/agents'

let applies = 0
describe('rebroadcast loop', () => {
  it('4-peer mesh', async () => {
    const m = createPeerMesh(4)
    // count receives by wrapping validateAuthored on every network
    const { getNetworks } = await import('./src/network/network')
    for (const p of m.peers)
      for (const n of getNetworks(p.world).values())
        n.validateAuthored = () => {
          applies++
          return true
        }
    await m.tick()
    const other = findUserByDID(m.peers[0].world, m.peers[1].world.localAgent.did)!
    spawnPrefab(m.peers[0].world, 'thing', { owner: other })
    applies = 0
    await m.tick()
    await m.tick()
    console.log('event deliveries:', applies)
    expect(applies).toBeLessThan(100)
  }, 10000)
})
