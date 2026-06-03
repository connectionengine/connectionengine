/**
 * @connectionengine/ad4m-bridge — minimal glue between Connection Engine and AD4M.
 *
 * Three things:
 *   1. `createAd4mAgent(client)` — Ad4mClient agent → core's opaque Agent.
 *   2. `eventToLink` / `linkExpressionToEvent` — AuthoredEvent ↔ AD4M Link.
 *   3. `connectAd4m(world, perspective)` — outbound via `perspective.addLinks`,
 *      inbound via `addListener('link-added')` → applyAuthoredEnvelope.
 *
 * Plus a convenience: `createAd4mRuntime(client, perspective)` wires all three.
 *
 * AD4M handles identity, signing, transport, persistence, replication at the
 * Holochain layer. This bridge is intentionally tiny — most of its code is
 * the Link encoding.
 *
 * Consumers that don't need AD4M never pull this package in; this package
 * depends on `@coasys/ad4m` so it's the only place AD4M's transitive deps
 * (Holochain client, base64-js, pako) are required.
 */

export * from './agent'
export * from './expression'
export * from './transport'
export * from './runtime'
