/**
 * The seam where the real payment integration plugs in.
 *
 * This file contains no Stripe code and holds no keys. Every call fails with
 * 501, because the alternative — returning a checkout URL that leads nowhere,
 * or accepting a webhook without verifying it — would let the control plane
 * grant entitlement for payments that never happened.
 *
 * Implementing it means:
 *
 * - `startCheckout`: create a Checkout Session for the plan's price with
 *   `client_reference_id` set to the account ID, and return the session ID as
 *   `reference` plus its hosted URL. Send an idempotency key derived from the
 *   account and plan so a double-clicked upgrade does not create two sessions.
 * - `parseWebhook`: verify the `Stripe-Signature` header against the raw
 *   request body with the endpoint's signing secret, rejecting a timestamp
 *   outside the replay window, then map `invoice.payment_succeeded` →
 *   `payment_succeeded`, `invoice.payment_failed` → `payment_failed` and
 *   `customer.subscription.deleted` → `subscription_canceled`. Return the
 *   Stripe event ID unchanged: the billing service uses it to apply each
 *   event exactly once, and Stripe retries deliveries.
 * - `cancel`: cancel the subscription at period end and let the resulting
 *   webhook settle local state, so one code path records the outcome.
 *
 * Note that the HTTP layer must hand `parseWebhook` the exact bytes received.
 * Re-serializing parsed JSON changes the payload and breaks the signature.
 */
import { UnsupportedError } from "../errors.js";
import type { PaymentProvider } from "./provider.js";

const DETAIL = "no payment integration is compiled into this build; see apps/cloud/src/billing/stripe.ts";

export function createStripeProvider(): PaymentProvider {
  return {
    name: "stripe",
    takesPayment: false,
    startCheckout: async () => {
      throw new UnsupportedError("stripe checkout", DETAIL);
    },
    cancel: async () => {
      throw new UnsupportedError("stripe cancellation", DETAIL);
    },
    parseWebhook: () => {
      throw new UnsupportedError("stripe webhook verification", DETAIL);
    },
  };
}
