/**
 * Opaque reference to credentials owned by the authentication capability.
 *
 * Accounts need to identify which credential and authentication method an
 * adapter should use, but they must never receive or persist the credential
 * material itself. Authentication adapters resolve this reference later in a
 * protected boundary.
 */
export interface CredentialReference {
  /** Stable identifier for the protected credential entry. */
  readonly id: string;
  /** Provider namespace, such as `codex` or `claude`. */
  readonly providerId: string;
  /** Provider-specific method name, kept opaque to the accounts module. */
  readonly method: string;
}

export type { CredentialMaterial, CredentialResolver, RuntimeContextResolver } from "./contracts.js";
