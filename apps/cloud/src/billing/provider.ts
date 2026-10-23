/**
 * The payment provider port.
 *
 * Everything that moves money sits behind this interface. The control plane
 * never calls a provider SDK directly, so the subscription rules can be tested
 * without network access and a second provider needs no changes above this
 * line.
 *
 * Implementations:
 * - `createManualProvider` — development and self-hosting. It takes no
 *   payment and says so; operators drive the subscription with signed events.
 * - `createStripeProvider` (`stripe.ts`) — the seam for the real integration.
 *   Every call fails with 501 rather than returning a plausible result.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { RequestValidationError, UnauthorizedError } from "../errors.js";

export interface CheckoutRequest {
  readonly accountId: string;
  readonly planId: string;
  readonly priceCents: number;
  readonly currency: string;
}

export interface CheckoutIntent {
  /** Provider-side identifier for the started checkout. */
  readonly reference: string;
  /** Where the user completes payment, when the provider hosts a page. */
  readonly url?: string;
  /**
   * What actually happens next, in plain words. Clients show this, so a
   * provider that takes no payment cannot be presented as one that did.
   */
  readonly instructions: string;
}

/** Provider events, normalized. Unknown event types are not invented here. */
export type PaymentEventType = "payment_succeeded" | "payment_failed" | "subscription_canceled";

export interface PaymentEvent {
  /** Provider event ID; used to apply each event exactly once. */
  readonly id: string;
  readonly type: PaymentEventType;
  readonly accountId: string;
  readonly planId?: string;
  readonly occurredAt: string;
}

export interface PaymentProvider {
  readonly name: string;
  /** False for a provider that cannot take payment; reported by `/health`. */
  readonly takesPayment: boolean;
  startCheckout(request: CheckoutRequest): Promise<CheckoutIntent>;
  /** Cancels at the provider. Local state is the service's responsibility. */
  cancel(reference: string): Promise<void>;
  /**
   * Verifies a webhook's authenticity and returns the normalized event.
   * Implementations must throw on a bad signature: this is the only thing
   * standing between the public internet and the billing state.
   */
  parseWebhook(payload: string, signature: string): PaymentEvent;
}

/**
 * A provider that takes no payment.
 *
 * It exists so the whole subscription lifecycle — checkout, renewal, dunning,
 * cancellation — can be exercised locally and in tests. The signature check is
 * real (HMAC-SHA256 over the raw body with a shared secret), so events cannot
 * be posted by anyone who lacks the secret; what is simulated is the money,
 * and `takesPayment: false` says so everywhere it is reported.
 */
export function createManualProvider(options: { readonly webhookSecret: string }): PaymentProvider {
  return {
    name: "manual",
    takesPayment: false,
    async startCheckout(request) {
      const reference = `manual_${request.accountId}_${request.planId}`;
      return {
        reference,
        instructions:
          `No payment was taken: this deployment has no payment provider configured. The subscription stays on its current plan until a signed ` +
          `payment_succeeded event for "${request.planId}" is posted to /v1/billing/webhook.`,
      };
    },
    async cancel() {
      // Nothing is held at a provider, so there is nothing to cancel there.
      // The service still records the cancellation locally.
    },
    parseWebhook(payload, signature) {
      const expected = createHmac("sha256", options.webhookSecret).update(payload, "utf8").digest();
      const presented = Buffer.from(signature, "hex");
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        throw new UnauthorizedError("webhook signature does not match");
      }
      return parseManualEvent(payload);
    },
  };
}

/** Signs a payload the way `createManualProvider` expects. Used by operators
 * posting events by hand, and by the tests that exercise the lifecycle. */
export function signManualWebhook(payload: string, webhookSecret: string): string {
  return createHmac("sha256", webhookSecret).update(payload, "utf8").digest("hex");
}

function parseManualEvent(payload: string): PaymentEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    throw new RequestValidationError("", "expected a JSON body");
  }
  if (typeof parsed !== "object" || parsed === null) throw new RequestValidationError("", "expected an object");
  const record = parsed as Record<string, unknown>;
  const type = record["type"];
  if (type !== "payment_succeeded" && type !== "payment_failed" && type !== "subscription_canceled") {
    throw new RequestValidationError("type", "expected payment_succeeded, payment_failed or subscription_canceled");
  }
  const id = record["id"];
  const accountId = record["accountId"];
  if (typeof id !== "string" || id === "") throw new RequestValidationError("id", "expected a non-empty string");
  if (typeof accountId !== "string" || accountId === "") throw new RequestValidationError("accountId", "expected a non-empty string");
  const planId = record["planId"];
  if (planId !== undefined && typeof planId !== "string") throw new RequestValidationError("planId", "expected a string");
  const occurredAt = record["occurredAt"];
  if (occurredAt !== undefined && (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt)))) {
    throw new RequestValidationError("occurredAt", "expected an ISO timestamp");
  }
  return {
    id,
    type,
    accountId,
    ...(planId === undefined ? {} : { planId }),
    occurredAt: occurredAt ?? new Date().toISOString(),
  };
}
