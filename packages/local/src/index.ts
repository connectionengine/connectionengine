/**
 * @connectionengine/local — fully-local runtime mode for Connection Engine.
 *
 * Provides:
 *   - Ed25519 / did:key identity (DID)
 *   - ZCAP-LD capability chains
 *   - Ed25519-signed in-memory transport (connectLocalInMemory)
 *   - Capability governance constraint kind, composed with core's engine-level
 *     credential + temporal + content constraints
 *   - createLocalRuntime convenience: world + agent + signing + governance
 *
 * Use this when you want full cryptographic guarantees without AD4M / Holochain.
 * For AD4M-backed identity + transport, use @connectionengine/ad4m-bridge instead.
 */

export * from './did'
export * from './zcap'
export * from './agent'
export * from './transport'
export * from './governance'
export * from './runtime'
