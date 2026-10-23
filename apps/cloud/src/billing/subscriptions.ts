/**
 * Subscription state transitions, as pure functions.
 *
 * The rules are small but easy to get wrong in ways that cost people money or
 * access, so they live apart from storage and HTTP and are tested directly.
 *
 * Two principles:
 * - **Access is never extended without evidence.** Only a payment event moves
 *   `currentPeriodEnd`; a checkout that was merely started changes nothing but
 *   `pendingPlanId`.
 * - **A lapse degrades, it does not erase.** A failed payment moves the
 *   subscription to `past_due`, which keeps entitlement until the period ends.
 *   Expiry then cancels it. Machines are never destroyed by billing state;
 *   provisioning simply stops.
 */
import { ConflictError } from "../errors.js";
import { DEFAULT_PLAN_ID, findPlan, type Plan } from "./plans.js";
import type { Entitlement, SubscriptionRecord } from "./types.js";

export const TRIAL_DURATION_MS = 14 * 24 * 60 * 60 * 1000;
export const PERIOD_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

export function startTrial(id: string, accountId: string, at: Date): SubscriptionRecord {
  const timestamp = at.toISOString();
  return {
    id,
    accountId,
    planId: DEFAULT_PLAN_ID,
    status: "trialing",
    createdAt: timestamp,
    updatedAt: timestamp,
    currentPeriodEnd: new Date(at.getTime() + TRIAL_DURATION_MS).toISOString(),
    cancelAtPeriodEnd: false,
  };
}

/**
 * Records the plan a started checkout will apply. The current plan is
 * untouched: the account must not gain a higher machine limit because a
 * checkout page was opened.
 */
export function startCheckout(subscription: SubscriptionRecord, plan: Plan, reference: { provider: string; reference: string }, at: Date): SubscriptionRecord {
  if (subscription.status === "canceled") {
    throw new ConflictError("this subscription is canceled; start a new one", { subscriptionId: subscription.id });
  }
  return { ...subscription, pendingPlanId: plan.id, provider: reference, updatedAt: at.toISOString() };
}

/**
 * Applies a successful payment: the pending plan becomes current, the status
 * becomes `active`, and the period is extended from the later of now and the
 * current end, so an early renewal does not shorten the paid period.
 */
export function applyPaymentSucceeded(subscription: SubscriptionRecord, at: Date, planId?: string): SubscriptionRecord {
  const target = planId ?? subscription.pendingPlanId ?? subscription.planId;
  if (findPlan(target) === undefined) {
    throw new ConflictError(`payment refers to unknown plan "${target}"`, { planId: target });
  }
  const base = Math.max(at.getTime(), Date.parse(subscription.currentPeriodEnd));
  const { pendingPlanId: _applied, ...rest } = subscription;
  return {
    ...rest,
    planId: target,
    status: "active",
    cancelAtPeriodEnd: false,
    currentPeriodEnd: new Date(base + PERIOD_DURATION_MS).toISOString(),
    updatedAt: at.toISOString(),
  };
}

/**
 * Applies a failed payment. Access continues until the period ends, which is
 * what the dunning window is for; `expire` cancels it afterwards.
 */
export function applyPaymentFailed(subscription: SubscriptionRecord, at: Date): SubscriptionRecord {
  if (subscription.status === "canceled") return subscription;
  return { ...subscription, status: "past_due", updatedAt: at.toISOString() };
}

/**
 * Cancels. By default the account keeps what it paid for until the period
 * ends; `immediate` is for a refund or an abuse decision and takes effect now.
 */
export function applyCancellation(subscription: SubscriptionRecord, at: Date, options: { readonly immediate: boolean }): SubscriptionRecord {
  const timestamp = at.toISOString();
  if (options.immediate) {
    return { ...subscription, status: "canceled", cancelAtPeriodEnd: false, currentPeriodEnd: timestamp, updatedAt: timestamp };
  }
  if (subscription.status === "canceled") return subscription;
  return { ...subscription, cancelAtPeriodEnd: true, updatedAt: timestamp };
}

/**
 * Settles a subscription whose period has ended. Returns `undefined` when
 * nothing changes, so callers can avoid a pointless write. This is applied on
 * read rather than by a scheduler: entitlement must be correct even if no
 * background job ran.
 */
export function expire(subscription: SubscriptionRecord, now: Date): SubscriptionRecord | undefined {
  if (subscription.status === "canceled") return undefined;
  if (Date.parse(subscription.currentPeriodEnd) > now.getTime()) return undefined;
  if (subscription.status === "active" && !subscription.cancelAtPeriodEnd) {
    // A paid subscription whose renewal event has not arrived yet is not
    // canceled; it is overdue. The provider's event decides which it becomes.
    return { ...subscription, status: "past_due", updatedAt: now.toISOString() };
  }
  return { ...subscription, status: "canceled", cancelAtPeriodEnd: false, updatedAt: now.toISOString() };
}

/** Resolves a subscription into the limits provisioning enforces. */
export function entitlementOf(subscription: SubscriptionRecord, now: Date): Entitlement {
  const plan = findPlan(subscription.planId);
  const base = {
    planId: subscription.planId,
    status: subscription.status,
    machineLimit: plan?.machineLimit ?? 0,
    snapshotLimit: plan?.snapshotLimit ?? 0,
  };
  if (plan === undefined) {
    return { ...base, mayProvision: false, blockedReason: `plan "${subscription.planId}" is no longer offered` };
  }
  if (subscription.status === "canceled") {
    return { ...base, mayProvision: false, blockedReason: "the subscription is canceled" };
  }
  if (Date.parse(subscription.currentPeriodEnd) <= now.getTime()) {
    return { ...base, mayProvision: false, blockedReason: subscription.status === "trialing" ? "the trial has ended" : "the current billing period has ended" };
  }
  return { ...base, mayProvision: true };
}
