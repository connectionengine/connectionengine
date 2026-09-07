/**
 * @connectionengine/local — the fully local runtime mode of Connection Engine.
 *
 * It supplies five things:
 *   - Ed25519 and did:key identity, as a DID
 *   - ZCAP-LD capability chains
 *   - An in-memory transport with Ed25519 signing, through
 *     `connectLocalInMemory`
 *   - A capability governance constraint kind. It composes with the
 *     engine-level credential, temporal, and content constraints of core.
 *   - `createLocalRuntime`, which builds the world, the agent, the signing, and
 *     the governance in one call
 *
 * Use this package when you want full cryptographic guarantees without AD4M or
 * Holochain. For AD4M-backed identity and transport, use
 * @connectionengine/ad4m-bridge instead.
 */

export * from './did'
export * from './zcap'
export * from './agent'
export * from './transport'
export * from './governance'
export * from './runtime'
