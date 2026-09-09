/**
 * The AD4M transport. It sends outbound events through `perspective.addLinks`,
 * and receives inbound events through `addListener('link-added', ...)`.
 *
 * The bridge verifies no signature. The executor of AD4M verifies
 * `LinkExpression.proof` at the Holochain layer, before it delivers to any
 * subscriber. This bridge trusts the executor.
 *
 * The module gives the world an `'ad4m'` network whose outbound path writes
 * Links. A Perspective is its own sync topology, so it gets its own network
 * rather than replacing the behaviour of an existing one. It does not handle
 * the `continuous` channel.
 * The binary SoA deltas usually ride a sibling transport, such as WebRTC,
 * because AD4M Links weigh too much for a per-tick packet.
 */

import type { LinkExpression, PerspectiveProxy } from '@coasys/ad4m'
import type { AddNetworkOptions, AuthoredEnvelope, World } from '@connectionengine/core'
import { addNetwork, applyAuthoredEnvelope, removeNetwork } from '@connectionengine/core'
import { eventToLink, linkExpressionToEvent } from './expression'

export interface Ad4mTransportHandle {
  close(): Promise<void>
}

/** The governance behaviours of the AD4M network. They are fixed when the
 *  network is built, so they are supplied here rather than assigned later. */
export type Ad4mTransportOptions = Pick<AddNetworkOptions, 'onValidateAuthored' | 'onRejected'>

/** Network id for the AD4M sync topology. A Perspective is its own topology,
 *  so it gets its own network rather than overriding the default one. */
export const AD4M_NETWORK_ID = 'ad4m'

export const connectAd4m = async (
  world: World,
  perspective: PerspectiveProxy,
  options: Ad4mTransportOptions = {}
): Promise<Ad4mTransportHandle> => {
  // Every behaviour is fixed when the network is built, so the network is built
  // here rather than an existing one being reassigned.
  const network = addNetwork(world, {
    ...options,
    id: AD4M_NETWORK_ID,
    onPublishAuthored: (_world, _network, envelope: AuthoredEnvelope) => {
      void perspective.addLinks(envelope.events.map(eventToLink))
    }
  })

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
      removeNetwork(world, AD4M_NETWORK_ID)
      await perspective.removeListener('link-added', listener)
    }
  }
}
