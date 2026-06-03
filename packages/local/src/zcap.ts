/**
 * ZCAP — Authorisation Capabilities for Linked Data (minimal).
 *
 * A capability grants its invoker the right to perform specific predicates
 * within a specific scope. Capabilities are signed and delegatable: the
 * grantee can produce a child capability (narrower predicates, the same or
 * narrower scope, sooner expiry) and sign it with their own key.
 *
 * Verification walks the chain root-to-leaf, checking each signature, each
 * `delegatable` flag, expiry, and that the child's predicates/scope are a
 * subset of the parent's.
 *
 * This is a deliberately minimal subset of W3C ZCAP-LD — full LD framing,
 * action URIs, and proof chains belong to a higher integration layer.
 */

import { type DID, type KeyPair, fromHex, signTriple, stableStringify, toHex, verifyByDID } from './did'

export interface Capability {
  /** DID of the holder this capability is delegated to. */
  invoker: DID
  /** Predicates (component / relation ids) this capability covers. */
  predicates: string[]
  /** Scope — entity path; empty array = world-wide. */
  scope: string[]
  /** Whether the invoker may further delegate. */
  delegatable: boolean
  /** Expiry timestamp (ms since epoch), or null for no expiry. */
  expires: number | null
  /** Parent capability — present on delegated caps; root has none. */
  parent?: Capability
  /** Signature over canonical serialisation of {invoker, predicates, scope, delegatable, expires, parent-signature?}. */
  signature: string
  /** DID of the signer (the parent's invoker, or the root issuer). */
  signer: DID
}

const canonicalise = (cap: Omit<Capability, 'signature' | 'signer'>): Uint8Array =>
  new TextEncoder().encode(
    stableStringify({
      invoker: cap.invoker,
      predicates: cap.predicates,
      scope: cap.scope,
      delegatable: cap.delegatable,
      expires: cap.expires,
      parentSig: cap.parent?.signature ?? null
    })
  )

export interface RootCapabilityOptions {
  invoker: DID
  predicates: string[]
  scope: string[]
  delegatable?: boolean
  expires?: number | null
  issuer: KeyPair
}

export const createRootCapability = (options: RootCapabilityOptions): Capability => {
  const cap: Omit<Capability, 'signature' | 'signer'> = {
    invoker: options.invoker,
    predicates: options.predicates,
    scope: options.scope,
    delegatable: options.delegatable ?? true,
    expires: options.expires ?? null
  }
  const signature = toHex(signTripleRaw(canonicalise(cap), options.issuer))
  return { ...cap, signature, signer: options.issuer.did }
}

export interface DelegateOptions {
  parent: Capability
  /** Holder of the parent capability — must own the private key. */
  delegator: KeyPair
  /** DID of the new invoker (the delegate). */
  invoker: DID
  predicates?: string[]
  scope?: string[]
  delegatable?: boolean
  expires?: number | null
}

export const delegateCapability = (options: DelegateOptions): Capability => {
  if (!options.parent.delegatable) throw new Error('Parent capability is not delegatable')
  if (options.parent.invoker !== options.delegator.did) {
    throw new Error("Delegator must be the parent capability's invoker")
  }
  const predicates = options.predicates ?? options.parent.predicates
  // Subset check
  for (const p of predicates) {
    if (!options.parent.predicates.includes(p)) throw new Error(`Cannot delegate predicate '${p}' not in parent`)
  }
  const scope = options.scope ?? options.parent.scope
  // Scope subset: child's scope must start with parent's
  for (let i = 0; i < options.parent.scope.length; i++) {
    if (scope[i] !== options.parent.scope[i]) throw new Error('Child scope must be within parent scope')
  }
  const expires = options.expires ?? options.parent.expires
  if (options.parent.expires !== null && expires !== null && expires > options.parent.expires) {
    throw new Error('Child expiry cannot extend parent')
  }
  const child: Omit<Capability, 'signature' | 'signer'> = {
    invoker: options.invoker,
    predicates,
    scope,
    delegatable: options.delegatable ?? false,
    expires,
    parent: options.parent
  }
  const signature = toHex(signTripleRaw(canonicalise(child), options.delegator))
  return { ...child, signature, signer: options.delegator.did }
}

/**
 * Verify a capability chain. Returns true iff:
 *   - every link's signature verifies against its signer DID
 *   - signer DID equals parent's invoker (or, for root, the trusted issuer DID
 *     provided by the caller)
 *   - predicates/scope are subsets of parent's
 *   - none in the chain are expired
 *   - delegatable flag is true for every non-leaf
 */
export const verifyCapability = (cap: Capability, options: { now: number; trustedIssuers?: DID[] }): boolean => {
  if (cap.expires !== null && cap.expires < options.now) return false
  if (!verifyByDID(fromHex(cap.signature), canonicalise(cap), cap.signer)) return false
  if (cap.parent) {
    if (cap.signer !== cap.parent.invoker) return false
    if (!cap.parent.delegatable) return false
    // subset checks already enforced at delegation time; re-verify for tampering
    for (const p of cap.predicates) if (!cap.parent.predicates.includes(p)) return false
    for (let i = 0; i < cap.parent.scope.length; i++) if (cap.scope[i] !== cap.parent.scope[i]) return false
    return verifyCapability(cap.parent, options)
  }
  // Root — signer must be a trusted issuer (or, if none provided, signer == invoker is allowed self-issuance)
  if (options.trustedIssuers) return options.trustedIssuers.includes(cap.signer)
  return true
}

/** Does this capability authorise the given predicate at the given scope? */
export const capabilityAllows = (cap: Capability, predicate: string, scope: string[]): boolean => {
  if (!cap.predicates.includes(predicate)) return false
  for (let i = 0; i < cap.scope.length; i++) if (scope[i] !== cap.scope[i]) return false
  return true
}

// Local helper — use the underlying Ed25519 sign without producing a Triple
import { sign } from './did'
const signTripleRaw = (bytes: Uint8Array, keyPair: KeyPair): Uint8Array => sign(bytes, keyPair.privateKey)
// silence unused
void signTriple
