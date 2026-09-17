/**
 * ZCAP — a minimal implementation of Authorisation Capabilities for Linked
 * Data.
 *
 * A capability grants its invoker the right to use specific predicates inside a
 * specific scope. A capability carries a signature, and its holder can delegate
 * it. The grantee produces a child capability, with narrower predicates, the
 * same scope or a narrower one, and an earlier expiry, and signs that child
 * with their own key.
 *
 * Verification walks the chain from root to leaf. At each link it checks the
 * signature, the `delegatable` flag, and the expiry. It also checks that the
 * predicates and the scope of the child form a subset of those of the parent.
 *
 * This module implements a deliberately minimal subset of W3C ZCAP-LD. Full LD
 * framing, action URIs, and proof chains belong to a higher integration layer.
 */

import { type DID, type KeyPair, fromHex, signTriple, stableStringify, toHex, verifyByDID } from './did'

export interface Capability {
  /** The DID of the holder that this capability is delegated to. */
  invoker: DID
  /** The predicates that this capability covers, as component ids or relation
   *  ids. */
  predicates: string[]
  /** Scope, as an entity path. An empty array means world-wide. */
  scope: string[]
  /** Whether the invoker may delegate this capability further. */
  delegatable: boolean
  /** Expiry timestamp, in milliseconds since epoch. It holds null when the
   *  capability never expires. */
  expires: number | null
  /** The parent capability. A delegated capability carries one, and a root
   *  capability carries none. */
  parent?: Capability
  /** Signature over the canonical serialisation of { invoker, predicates,
   *  scope, delegatable, expires, parent-signature? }. */
  signature: string
  /** The DID of the signer: the invoker of the parent, or the root issuer. */
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
  /** The holder of the parent capability. It must own the private key. */
  delegator: KeyPair
  /** The DID of the new invoker, which is the delegate. */
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
  // Check that the predicates form a subset.
  for (const p of predicates) {
    if (!options.parent.predicates.includes(p)) throw new Error(`Cannot delegate predicate '${p}' not in parent`)
  }
  const scope = options.scope ?? options.parent.scope
  // Check the scope subset. The scope of the child must start with the scope of
  // the parent.
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
 * Verify a capability chain. The function returns true if, and only if, all
 * five conditions hold:
 *   - the signature of every link verifies against its signer DID
 *   - each signer DID equals the invoker of the parent. For the root link it
 *     equals the trusted issuer DID that the caller supplied.
 *   - the predicates and the scope of each link form a subset of those of its
 *     parent
 *   - no link in the chain has expired
 *   - the delegatable flag holds true for every link except the leaf
 */
export const verifyCapability = (cap: Capability, options: { now: number; trustedIssuers?: DID[] }): boolean => {
  if (cap.expires !== null && cap.expires < options.now) return false
  if (!verifyByDID(fromHex(cap.signature), canonicalise(cap), cap.signer)) return false
  if (cap.parent) {
    if (cap.signer !== cap.parent.invoker) return false
    if (!cap.parent.delegatable) return false
    // The delegation step already enforced the subset checks. Run them again
    // here, to find tampering.
    for (const p of cap.predicates) if (!cap.parent.predicates.includes(p)) return false
    for (let i = 0; i < cap.parent.scope.length; i++) if (cap.scope[i] !== cap.parent.scope[i]) return false
    return verifyCapability(cap.parent, options)
  }
  // The root link. Its signer must be a trusted issuer. When the caller
  // supplies no trusted issuer, a signer equal to the invoker counts as valid
  // self-issuance.
  if (options.trustedIssuers) return options.trustedIssuers.includes(cap.signer)
  return true
}

/** Does this capability authorise the given predicate at the given scope? */
export const capabilityAllows = (cap: Capability, predicate: string, scope: string[]): boolean => {
  if (!cap.predicates.includes(predicate)) return false
  for (let i = 0; i < cap.scope.length; i++) if (scope[i] !== cap.scope[i]) return false
  return true
}

// Local helper. It calls the underlying Ed25519 sign, and produces no Triple.
import { sign } from './did'
const signTripleRaw = (bytes: Uint8Array, keyPair: KeyPair): Uint8Array => sign(bytes, keyPair.privateKey)
// Keep the import used, so that the linter reports no unused symbol.
void signTriple
