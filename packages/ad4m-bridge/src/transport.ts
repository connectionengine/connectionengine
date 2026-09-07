/**
 * The AD4M transport. It sends outbound events through `perspective.addLinks`,
 * and receives inbound events through `addListener('link-added', ...)`.
 *
 * The bridge verifies no signature. The executor of AD4M verifies
 * `LinkExpression.proof` at the Holochain layer, before it delivers to any
 * subscriber. This bridge trusts the executor.
 *
 * The module attaches the publishAuthored hook of the `'default'` network of
 * the world to the Perspective. It does not handle the `continuous` channel.
 * The binary SoA deltas usually ride a sibling transport, such as WebRTC,
 * because AD4M Links weigh too much for a per-tick packet.
 */

import type { LinkExpression, PerspectiveProxy } from '@coasys/ad4m'
import type { AuthoredEnvelope, World } from '@connectionengine/core'
import { applyAuthoredEnvelope, ensureDefaultNetwork } from '@connectionengine/core'
import { eventToLink, linkExpressionToEvent } from './expression'

export interface Ad4mTransportHandle {
  close(): Promise<void>
}

export const connectAd4m = async (world: World, perspective: PerspectiveProxy): Promise<Ad4mTransportHandle> => {
  const network = ensureDefaultNetwork(world)
  network.publishAuthored = (envelope: AuthoredEnvelope) => {
    void perspective.addLinks(envelope.events.map(eventToLink))
  }

  // The inbound path: a link-added subscription. By convention, the LinkCallback
  // of AD4M returns null. The real work happens as a side effect, which feeds
  // the engine.
  const listener = (le: LinkExpression): null => {
    const event = linkExpressionToEvent(le)
    if (!event) return null
    if (event.author === world.localAgent.did) return null // ignore our own echoes
    applyAuthoredEnvelope(world, { events: [event], fromPeer: le.author }, network)
    return null
  }
  await perspective.addListener('link-added', listener)

  return {
    close: async () => {
      network.publishAuthored = undefined
      await perspective.removeListener('link-added', listener)
    }
  }
}
