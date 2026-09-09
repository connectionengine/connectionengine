/**
 * @connectionengine/ad4m-bridge — the minimal glue between Connection Engine
 * and AD4M.
 *
 * It supplies three things:
 *   1. `createAd4mAgent(client)` — it converts the agent of an Ad4mClient into
 *      the opaque Agent of core.
 *   2. `eventToLink` and `linkExpressionToEvent` — they convert between an
 *      AuthoredEvent and an AD4M Link.
 *   3. `connectAd4m(world, perspective)` — it sends outbound events through
 *      `perspective.addLinks`, and receives inbound events through
 *      `addListener('link-added')`, which calls applyAuthoredEnvelope.
 *
 * It also supplies one convenience function. `createAd4mRuntime(client,
 * perspective)` attaches all three.
 *
 * AD4M handles the identity, the signing, the transport, the persistence, and
 * the replication, at the Holochain layer. Little remains for this bridge to
 * do, and most of its code performs the Link encoding.
 *
 * A consumer that does not need AD4M never installs this package. This package
 * depends on `@coasys/ad4m`, so it is the only place that requires the
 * transitive dependencies of AD4M: the Holochain client, base64-js, and pako.
 */

export * from './agent'
export * from './expression'
export * from './transport'
export * from './runtime'
