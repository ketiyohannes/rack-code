/**
 * Subscriptions: the account-facing operations and the provider event intake.
 *
 * The service owns persistence and ordering; `subscriptions.ts` owns the
 * rules. Entitlement is computed on read and any expiry it discovers is
 * written back, so a deployment with no scheduler still answers correctly.
 */
import { ConflictError, NotFoundError } from "../errors.js";
import { newId } from "../ids.js";
import { PLANS, findPlan, type Plan } from "./plans.js";
import { applyCancellation, applyPaymentFailed, applyPaymentSucceeded, entitlementOf, expire, startCheckout, startTrial } from "./subscriptions.js";
import type { CheckoutIntent, PaymentEvent, PaymentProvider } from "./provider.js";
import type { BillingDocument, Entitlement, SubscriptionRecord } from "./types.js";
import type { Document } from "../storage.js";

export class BillingService {
  constructor(
    private readonly document: Document<BillingDocument>,
    private readonly provider: PaymentProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get providerName(): string {
    return this.provider.name;
  }

  get takesPayment(): boolean {
    return this.provider.takesPayment;
  }

  listPlans(): readonly Plan[] {
    return PLANS;
  }

  /**
   * Creates the account's first subscription, or returns the existing one.
   *
   * Sign-up composes two capabilities, so it can fail between them; making
   * this idempotent means an interrupted sign-up heals on the next read
   * instead of leaving an account that can never provision. Billing is called
   * by that workflow rather than by Accounts, so identity does not depend on
   * billing.
   */
  async ensureTrial(accountId: string): Promise<SubscriptionRecord> {
    const subscription = startTrial(newId("sub"), accountId, this.now());
    let stored = subscription;
    await this.document.update((current) => {
      const existing = current.subscriptions.find((candidate) => candidate.accountId === accountId);
      if (existing !== undefined) {
        stored = existing;
        return current;
      }
      return { ...current, subscriptions: [...current.subscriptions, subscription] };
    });
    return stored;
  }

  /** Reads the subscription, settling an expired period as a side effect. */
  async get(accountId: string): Promise<SubscriptionRecord> {
    const stored = (await this.document.read()).subscriptions.find((candidate) => candidate.accountId === accountId);
    if (stored === undefined) throw new NotFoundError("subscription for account", accountId);
    const expired = expire(stored, this.now());
    return expired === undefined ? stored : this.replace(expired);
  }

  async entitlement(accountId: string): Promise<Entitlement> {
    return entitlementOf(await this.get(accountId), this.now());
  }

  /**
   * Starts a plan change at the provider. The returned instructions are the
   * provider's own words about what happens next; a provider that cannot take
   * payment says so there rather than leaving the client to assume.
   */
  async startCheckout(accountId: string, planId: string): Promise<{ subscription: SubscriptionRecord; intent: CheckoutIntent }> {
    const plan = findPlan(planId);
    if (plan === undefined) throw new NotFoundError("plan", planId);
    const subscription = await this.get(accountId);
    if (subscription.planId === plan.id && subscription.status === "active") {
      throw new ConflictError(`the account is already on the "${plan.id}" plan`, { planId: plan.id });
    }
    const intent = await this.provider.startCheckout({ accountId, planId: plan.id, priceCents: plan.priceCents, currency: plan.currency });
    const updated = startCheckout(subscription, plan, { provider: this.provider.name, reference: intent.reference }, this.now());
    return { subscription: await this.replace(updated), intent };
  }

  /**
   * Cancels locally and at the provider. The provider call comes first: if it
   * fails, the account keeps a subscription that is still being billed, which
   * is recoverable. Recording a cancellation the provider never received is
   * not — the account would stop paying and keep its machines.
   */
  async cancel(accountId: string, options: { readonly immediate: boolean }): Promise<SubscriptionRecord> {
    const subscription = await this.get(accountId);
    if (subscription.provider !== undefined) await this.provider.cancel(subscription.provider.reference);
    const canceled = applyCancellation(subscription, this.now(), options);
    await this.record(accountId, newId("evt"), options.immediate ? "cancellation_immediate" : "cancellation_at_period_end", "requested by the account holder");
    return this.replace(canceled);
  }

  /**
   * Verifies and applies a provider webhook. Providers retry deliveries, so
   * an event ID that was already applied is accepted and ignored rather than
   * applied twice: a duplicate renewal would extend a period that was paid
   * for once.
   */
  async applyWebhook(payload: string, signature: string): Promise<{ applied: boolean; subscription: SubscriptionRecord }> {
    const event = this.provider.parseWebhook(payload, signature);
    const snapshot = await this.document.read();
    const subscription = snapshot.subscriptions.find((candidate) => candidate.accountId === event.accountId);
    if (subscription === undefined) throw new NotFoundError("subscription for account", event.accountId);
    if (snapshot.events.some((recorded) => recorded.id === event.id)) {
      return { applied: false, subscription };
    }
    const updated = this.apply(subscription, event);
    await this.record(event.accountId, event.id, event.type, `${this.provider.name} event applied`);
    return { applied: true, subscription: await this.replace(updated) };
  }

  private apply(subscription: SubscriptionRecord, event: PaymentEvent): SubscriptionRecord {
    const at = new Date(event.occurredAt);
    switch (event.type) {
      case "payment_succeeded":
        return applyPaymentSucceeded(subscription, at, event.planId);
      case "payment_failed":
        return applyPaymentFailed(subscription, at);
      case "subscription_canceled":
        return applyCancellation(subscription, at, { immediate: true });
    }
  }

  private async record(accountId: string, id: string, type: string, detail: string): Promise<void> {
    const at = this.now().toISOString();
    await this.document.update((current) =>
      current.events.some((event) => event.id === id)
        ? current
        : { ...current, events: [...current.events, { id, accountId, type, at, detail }] },
    );
  }

  private async replace(subscription: SubscriptionRecord): Promise<SubscriptionRecord> {
    await this.document.update((current) => ({
      ...current,
      subscriptions: current.subscriptions.map((candidate) => (candidate.id === subscription.id ? subscription : candidate)),
    }));
    return subscription;
  }
}
