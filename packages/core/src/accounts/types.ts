import type { CredentialReference } from "../authentication/index.js";

/** Provider identifiers are data so a future runtime can be added without changing account rules. */
export type ProviderId = string;

/** Application-owned identifier for a saved account. */
export type AccountId = string;

/** Opaque identifier for the isolated runtime configuration used by one account. */
export type RuntimeContextId = string;

/** Current operational state observed for an account by its provider adapter. */
export type AccountAvailability =
  | "unknown"
  | "available"
  | "unavailable"
  | "reauth_required";

/** Provider identity information safe for the application to display and persist. */
export interface AccountIdentity {
  /** Stable provider-side account identifier, not a credential. */
  readonly providerAccountId: string;
  readonly email?: string;
  readonly displayName?: string;
}

/** A saved account record. Secrets are deliberately absent from this type. */
export interface AccountRecord {
  readonly id: AccountId;
  readonly providerId: ProviderId;
  readonly identity: AccountIdentity;
  readonly credential: CredentialReference;
  readonly runtimeContextId: RuntimeContextId;
  readonly availability: AccountAvailability;
  readonly availabilityReason?: string;
  readonly quotaResetAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Last time an execution attempt actually used this account. */
  readonly lastUsedAt?: string;
}

/** Input required to register an account without exposing credential material. */
export interface RegisterAccountInput {
  readonly id?: AccountId;
  readonly providerId: ProviderId;
  readonly identity: AccountIdentity;
  readonly credential: CredentialReference;
  readonly runtimeContextId: RuntimeContextId;
  readonly availability?: AccountAvailability;
}

/** New opaque credential reference recorded after a host completes re-authentication. */
export interface ReauthenticateAccountInput {
  readonly credential: CredentialReference;
  /** A new context can be supplied when the provider rotates native session state. */
  readonly runtimeContextId?: RuntimeContextId;
}

/** Observation supplied by a provider adapter after checking account health or quota. */
export interface AccountAvailabilityObservation {
  readonly status: AccountAvailability;
  readonly observedAt?: string;
  readonly reason?: string;
  readonly quotaResetAt?: string;
}
