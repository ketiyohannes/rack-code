/**
 * Subscription state and its audit trail.
 *
 * The control plane keeps its own subscription record rather than asking the
 * payment provider on every request: provisioning must stay available when the
 * provider is not, and a provider outage must not read as "nobody may create
 * machines". The provider remains the source of truth for money; this record
 * is the source of truth for entitlement, updated from provider events.
 */

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled";

/** Identifies the subscription at the payment provider, once one exists. */
export interface ProviderReference {
  readonly provider: string;
  readonly reference: string;
}

export interface SubscriptionRecord {
  readonly id: string;
  readonly accountId: string;
  readonly planId: string;
  readonly status: SubscriptionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Entitlement lasts until this instant; `trialing` and `past_due` expire. */
  readonly currentPeriodEnd: string;
  /** Set by a cancellation that keeps access until the period ends. */
  readonly cancelAtPeriodEnd: boolean;
  /** The plan a started checkout will move to once payment succeeds. */
  readonly pendingPlanId?: string;
  readonly provider?: ProviderReference;
}

/**
 * An applied provider event. Stored to make webhook delivery idempotent:
 * providers retry, and applying a renewal twice would extend a period that was
 * only paid for once.
 */
export interface BillingEventRecord {
  readonly id: string;
  readonly accountId: string;
  readonly type: string;
  readonly at: string;
  readonly detail: string;
}

export interface BillingDocument {
  readonly schema: 1;
  readonly subscriptions: readonly SubscriptionRecord[];
  readonly events: readonly BillingEventRecord[];
}

export const EMPTY_BILLING_DOCUMENT: BillingDocument = { schema: 1, subscriptions: [], events: [] };

/** What the rest of the control plane needs to know about a subscription. */
export interface Entitlement {
  readonly planId: string;
  readonly status: SubscriptionStatus;
  readonly machineLimit: number;
  readonly snapshotLimit: number;
  readonly mayProvision: boolean;
  /** Present when `mayProvision` is false, for the message shown to the user. */
  readonly blockedReason?: string;
}
