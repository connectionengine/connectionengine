/**
 * The AD4M transport. It sends outbound events through `perspective.addLinks`,
 * and receives inbound events through `addListener('link-added', ...)`.
 *
 * Outbound: a Connection on a Network. The mutation pipeline fans authored
 * envelopes to every connection on every network. The connection's
 * `events.send` converts each envelope to AD4M Links via `perspective.addLinks`.
 *
 * Inbound: a `link-added` listener on the Perspective. Each link converts to
 * an authored event and applies through `applyAuthoredEnvelope`. The executor
 * of AD4M verifies `LinkExpression.proof` at the Holochain layer, before it
 * delivers to any subscriber. This bridge trusts the executor. Engine-internal
 * governance (`validateEvent`) checks each event on arrival.
 *
 * A Perspective acts as its own sync topology. The binary SoA deltas usually
 * ride a sibling transport, such as WebRTC, because AD4M Links weigh too much
 * for a per-tick packet. The connection's `stream` channel stays inert.
 *
 * Governance runs engine-internally. Add constraint entities to the world
 * before connecting.
 */

import type { LinkExpression, PerspectiveProxy } from '@coasys/ad4m'
import type { AuthoredEnvelope, Connection, World } from '@connectionengine/core'
import { applyAuthoredEnvelope, ensureDefaultNetwork, isAuthoredEnvelope } from '@connectionengine/core'
import { attachConnection } from '@connectionengine/core'
import { eventToLink, linkExpressionToEvent } from './expression'

export interface Ad4mTransportHandle {
  close(): Promise<void>
}

export const connectAd4m = async (world: World, perspective: PerspectiveProxy): Promise<Ad4mTransportHandle> => {
  const network = ensureDefaultNetwork(world)
  const closeHandlers = new Set<() => void>()

  // Build a Connection whose events channel publishes through AD4M Links.
  // The stream channel (binary SoA deltas) stays inert — AD4M Links cost
  // too much for per-tick packets. A sibling WebRTC transport handles that.
  const connection: Connection = {
    peer: 0,
    events: {
      send: (payload: unknown) => {
        if (!isAuthoredEnvelope(payload)) return
        const envelope = payload as AuthoredEnvelope
        void perspective.addLinks(envelope.events.map(eventToLink))
      },
      onMessage: (handler) => {
        // The inbound path uses a link-added listener below, not this
        // channel. Nothing calls onMessage on the outbound-only side.
        void handler
        return () => {}
      }
    },
    stream: {
      send: () => {},
      onMessage: () => () => {}
    },
    onClose: (handler) => {
      closeHandlers.add(handler)
      return () => closeHandlers.delete(handler)
    },
    close: () => {
      for (const h of closeHandlers) h()
      closeHandlers.clear()
    }
  }

  attachConnection(world, network, connection)

  // The inbound path: a link-added subscription. By convention, the
  // LinkCallback of AD4M returns null. The real work happens as a side
  // effect, which feeds the engine. Governance runs engine-internally.
  const listener = (le: LinkExpression): null => {
    const event = linkExpressionToEvent(le)
    if (!event) return null
    if (event.author === world.localAgent.did) return null // ignore our own echoes
    applyAuthoredEnvelope(world, { events: [event], fromPeer: le.author })
    return null
  }
  await perspective.addListener('link-added', listener)

  return {
    close: async () => {
      connection.close()
      await perspective.removeListener('link-added', listener)
    }
  }
}
