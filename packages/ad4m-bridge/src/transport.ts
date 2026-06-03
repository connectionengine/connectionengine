/**
 * AD4M transport — outbound via `perspective.addLinks`, inbound via
 * `addListener('link-added', ...)`.
 *
 * The bridge does no signature verification — AD4M's executor verifies
 * `LinkExpression.proof` at the Holochain layer before delivering to
 * subscribers. We trust the executor.
 */

import type { LinkExpression, PerspectiveProxy } from '@coasys/ad4m'
import type { AuthoredEnvelope, World } from '@connectionengine/core'
import { applyAuthoredEnvelope } from '@connectionengine/core'
import { eventToLink, linkExpressionToEvent } from './expression'

export interface Ad4mTransportHandle {
  close(): Promise<void>
}

export const connectAd4m = async (world: World, perspective: PerspectiveProxy): Promise<Ad4mTransportHandle> => {
  // Outbound — replace publishAuthored
  world.network.publishAuthored = (envelope: AuthoredEnvelope) => {
    void perspective.addLinks(envelope.events.map(eventToLink)).catch((err) => {
      world.trace.emit({
        kind: 'transport.send',
        ts: world.clock.now(),
        detail: { kind: 'ad4m-error', error: String(err) }
      })
    })
    world.trace.emit({
      kind: 'transport.send',
      ts: world.clock.now(),
      peer: world.network.localAgent.did,
      detail: { kind: 'authored', count: envelope.events.length }
    })
  }

  // Inbound — link-added subscription. AD4M's LinkCallback returns null by
  // convention; the work is the side effect of feeding the engine.
  const listener = (le: LinkExpression): null => {
    const event = linkExpressionToEvent(le)
    if (!event) return null
    if (event.author === world.network.localAgent.did) return null // ignore our own echoes
    applyAuthoredEnvelope(world, { events: [event], fromPeer: le.author })
    return null
  }
  await perspective.addListener('link-added', listener)

  return {
    close: async () => {
      world.network.publishAuthored = undefined
      await perspective.removeListener('link-added', listener)
    }
  }
}
