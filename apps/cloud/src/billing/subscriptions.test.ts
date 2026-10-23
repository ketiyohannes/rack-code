import assert from "node:assert/strict";
import test from "node:test";
import {
  PERIOD_DURATION_MS,
  TRIAL_DURATION_MS,
  applyCancellation,
  applyPaymentFailed,
  applyPaymentSucceeded,
  entitlementOf,
  expire,
  startCheckout,
  startTrial,
} from "./subscriptions.js";
import { findPlan } from "./plans.js";
import { ConflictError } from "../errors.js";

const START = new Date("2026-10-23T10:00:00.000Z");
const PRO = findPlan("pro")!;

function trial() {
  return startTrial("sub_1", "acc_1", START);
}

test("a new account starts on a time-limited free trial", () => {
  const subscription = trial();
  assert.equal(subscription.status, "trialing");
  assert.equal(subscription.planId, "free");
  assert.equal(Date.parse(subscription.currentPeriodEnd) - START.getTime(), TRIAL_DURATION_MS);
  assert.equal(entitlementOf(subscription, START).mayProvision, true);
  assert.equal(entitlementOf(subscription, START).machineLimit, findPlan("free")?.machineLimit);
});

test("starting a checkout grants nothing until a payment event arrives", () => {
  const started = startCheckout(trial(), PRO, { provider: "manual", reference: "ref_1" }, START);
  assert.equal(started.pendingPlanId, "pro");
  assert.equal(started.planId, "free", "the plan does not change because a checkout page was opened");
  assert.equal(entitlementOf(started, START).machineLimit, findPlan("free")?.machineLimit);

  const paid = applyPaymentSucceeded(started, START);
  assert.equal(paid.planId, "pro");
  assert.equal(paid.status, "active");
  assert.equal(paid.pendingPlanId, undefined);
  assert.equal(entitlementOf(paid, START).machineLimit, PRO.machineLimit);
});

test("renewal extends from the end of the paid period, not from the payment", () => {
  const paid = applyPaymentSucceeded(startCheckout(trial(), PRO, { provider: "manual", reference: "ref_1" }, START), START);
  const early = new Date(Date.parse(paid.currentPeriodEnd) - 2 * 24 * 60 * 60 * 1000);
  const renewed = applyPaymentSucceeded(paid, early);
  assert.equal(Date.parse(renewed.currentPeriodEnd) - Date.parse(paid.currentPeriodEnd), PERIOD_DURATION_MS, "an early renewal must not shorten the paid period");

  const late = new Date(Date.parse(paid.currentPeriodEnd) + 24 * 60 * 60 * 1000);
  assert.equal(Date.parse(applyPaymentSucceeded(paid, late).currentPeriodEnd) - late.getTime(), PERIOD_DURATION_MS);
});

test("a failed payment degrades access at the end of the period rather than at once", () => {
  const paid = applyPaymentSucceeded(startCheckout(trial(), PRO, { provider: "manual", reference: "ref_1" }, START), START);
  const failed = applyPaymentFailed(paid, START);
  assert.equal(failed.status, "past_due");
  assert.equal(entitlementOf(failed, START).mayProvision, true, "the dunning window keeps the account working");

  const afterPeriod = new Date(Date.parse(failed.currentPeriodEnd) + 1000);
  const expired = expire(failed, afterPeriod);
  assert.equal(expired?.status, "canceled");
  assert.equal(entitlementOf(expired!, afterPeriod).mayProvision, false);
  assert.match(entitlementOf(expired!, afterPeriod).blockedReason ?? "", /canceled/);
});

test("an overdue renewal is past_due, not canceled", () => {
  const paid = applyPaymentSucceeded(startCheckout(trial(), PRO, { provider: "manual", reference: "ref_1" }, START), START);
  const afterPeriod = new Date(Date.parse(paid.currentPeriodEnd) + 1000);
  // The provider's renewal event has not arrived; the subscription is overdue,
  // and the next event decides whether it renews or lapses.
  assert.equal(expire(paid, afterPeriod)?.status, "past_due");
  assert.equal(expire(paid, START), undefined, "a live period is left alone");
});

test("cancellation keeps paid access until the period ends unless it is immediate", () => {
  const paid = applyPaymentSucceeded(startCheckout(trial(), PRO, { provider: "manual", reference: "ref_1" }, START), START);
  const atPeriodEnd = applyCancellation(paid, START, { immediate: false });
  assert.equal(atPeriodEnd.status, "active");
  assert.equal(atPeriodEnd.cancelAtPeriodEnd, true);
  assert.equal(entitlementOf(atPeriodEnd, START).mayProvision, true);
  assert.equal(expire(atPeriodEnd, new Date(Date.parse(paid.currentPeriodEnd) + 1000))?.status, "canceled");

  const now = applyCancellation(paid, START, { immediate: true });
  assert.equal(now.status, "canceled");
  assert.equal(entitlementOf(now, START).mayProvision, false);
  assert.throws(() => startCheckout(now, PRO, { provider: "manual", reference: "ref_2" }, START), ConflictError);
});

test("an expired trial blocks provisioning with a reason the user can act on", () => {
  const subscription = trial();
  const afterTrial = new Date(START.getTime() + TRIAL_DURATION_MS + 1000);
  const entitlement = entitlementOf(subscription, afterTrial);
  assert.equal(entitlement.mayProvision, false);
  assert.match(entitlement.blockedReason ?? "", /trial has ended/);
  assert.equal(expire(subscription, afterTrial)?.status, "canceled");
});

test("a payment for a plan that no longer exists is refused instead of applied", () => {
  assert.throws(() => applyPaymentSucceeded(trial(), START, "enterprise"), ConflictError);
});
