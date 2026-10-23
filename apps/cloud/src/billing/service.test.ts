import assert from "node:assert/strict";
import test from "node:test";
import { BillingService } from "./service.js";
import { createManualProvider, signManualWebhook } from "./provider.js";
import { createStripeProvider } from "./stripe.js";
import { EMPTY_BILLING_DOCUMENT, type BillingDocument } from "./types.js";
import { MemoryDocument } from "../storage.js";
import { NotFoundError, UnauthorizedError, UnsupportedError } from "../errors.js";

const SECRET = "webhook-secret-for-tests-0123456789";

function billing(now: () => Date = () => new Date("2026-10-23T10:00:00.000Z")): { service: BillingService; document: MemoryDocument<BillingDocument> } {
  const document = new MemoryDocument<BillingDocument>(EMPTY_BILLING_DOCUMENT);
  return { service: new BillingService(document, createManualProvider({ webhookSecret: SECRET }), now), document };
}

function event(body: Record<string, unknown>): { payload: string; signature: string } {
  const payload = JSON.stringify(body);
  return { payload, signature: signManualWebhook(payload, SECRET) };
}

test("the trial is created once, however many times sign-up is retried", async () => {
  const { service } = billing();
  const first = await service.ensureTrial("acc_1");
  const second = await service.ensureTrial("acc_1");
  assert.equal(second.id, first.id);
  assert.equal((await service.get("acc_1")).status, "trialing");
  await assert.rejects(service.get("acc_unknown"), NotFoundError);
});

test("a provider that takes no payment says so in the checkout it returns", async () => {
  const { service } = billing();
  await service.ensureTrial("acc_1");
  const { intent, subscription } = await service.startCheckout("acc_1", "pro");
  assert.equal(service.takesPayment, false);
  assert.match(intent.instructions, /No payment was taken/);
  assert.equal(subscription.planId, "free", "entitlement does not move before payment");
  assert.equal(subscription.pendingPlanId, "pro");
  await assert.rejects(service.startCheckout("acc_1", "enterprise"), NotFoundError);
});

test("webhooks are authenticated and applied exactly once", async () => {
  const { service, document } = billing();
  await service.ensureTrial("acc_1");
  await service.startCheckout("acc_1", "pro");

  const renewal = event({ id: "evt_1", type: "payment_succeeded", accountId: "acc_1", occurredAt: "2026-10-23T10:05:00.000Z" });
  await assert.rejects(service.applyWebhook(renewal.payload, "00".repeat(32)), UnauthorizedError);
  await assert.rejects(service.applyWebhook(renewal.payload, signManualWebhook(`${renewal.payload} `, SECRET)), UnauthorizedError);

  const applied = await service.applyWebhook(renewal.payload, renewal.signature);
  assert.equal(applied.applied, true);
  assert.equal(applied.subscription.planId, "pro");
  const periodEnd = applied.subscription.currentPeriodEnd;

  // Providers retry deliveries; a replay must not extend a paid period.
  const retried = await service.applyWebhook(renewal.payload, renewal.signature);
  assert.equal(retried.applied, false);
  assert.equal(retried.subscription.currentPeriodEnd, periodEnd);
  assert.equal((await document.read()).events.filter((recorded) => recorded.id === "evt_1").length, 1);
});

test("a dunning cycle is recorded end to end", async () => {
  let now = new Date("2026-10-23T10:00:00.000Z");
  const { service } = billing(() => now);
  await service.ensureTrial("acc_1");
  await service.startCheckout("acc_1", "pro");
  const paid = event({ id: "evt_1", type: "payment_succeeded", accountId: "acc_1", occurredAt: now.toISOString() });
  await service.applyWebhook(paid.payload, paid.signature);

  const failure = event({ id: "evt_2", type: "payment_failed", accountId: "acc_1", occurredAt: now.toISOString() });
  const failed = await service.applyWebhook(failure.payload, failure.signature);
  assert.equal(failed.subscription.status, "past_due");
  assert.equal((await service.entitlement("acc_1")).mayProvision, true);

  // Reading after the period has ended settles the lapse without a scheduler.
  now = new Date(Date.parse(failed.subscription.currentPeriodEnd) + 1000);
  assert.equal((await service.get("acc_1")).status, "canceled");
  const entitlement = await service.entitlement("acc_1");
  assert.equal(entitlement.mayProvision, false);
  assert.match(entitlement.blockedReason ?? "", /canceled/);
});

test("an event for an unknown account changes nothing", async () => {
  const { service, document } = billing();
  await service.ensureTrial("acc_1");
  const stray = event({ id: "evt_9", type: "payment_succeeded", accountId: "acc_other" });
  await assert.rejects(service.applyWebhook(stray.payload, stray.signature), NotFoundError);
  assert.deepEqual((await document.read()).events, []);
  assert.equal((await service.get("acc_1")).status, "trialing");
});

test("the unimplemented payment provider refuses instead of returning a checkout", async () => {
  const document = new MemoryDocument<BillingDocument>(EMPTY_BILLING_DOCUMENT);
  const service = new BillingService(document, createStripeProvider());
  await service.ensureTrial("acc_1");
  await assert.rejects(service.startCheckout("acc_1", "pro"), UnsupportedError);
  await assert.rejects(service.applyWebhook("{}", "signature"), UnsupportedError);
  assert.equal((await service.get("acc_1")).pendingPlanId, undefined, "a refused checkout leaves no pending plan");
});
