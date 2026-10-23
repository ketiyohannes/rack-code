/**
 * The route table.
 *
 * Routes are thin: they validate input, call one capability and shape the
 * response. The two cross-capability workflows the control plane has —
 * sign-up (identity plus a trial subscription) and provisioning (entitlement
 * plus vm-manager) — are coordinated here and in `ProvisioningService`
 * respectively, rather than by letting one capability reach into another.
 *
 * Responses never contain credential material except where a secret is being
 * issued, and an issued secret is returned exactly once.
 */
import { UnauthorizedError } from "../errors.js";
import { asRecord, optionalBoolean, optionalInteger, optionalText, rejectUnknownKeys, requiredEmail, requiredPassword, requiredStringArray, requiredText } from "../validation.js";
import { toAccountView } from "../accounts/types.js";
import { pathParam, requireAccount, type Route } from "./server.js";
import type { CloudApplication } from "../application.js";

/** Header carrying the payment provider's webhook signature. */
const SIGNATURE_HEADER = "x-rack-signature";

export function createRoutes(application: CloudApplication): readonly Route[] {
  const { accounts, billing, provisioning, registry, relay } = application;

  return [
    {
      method: "POST",
      path: "/v1/accounts",
      auth: "public",
      handle: async ({ body }) => {
        const record = asRecord(body);
        rejectUnknownKeys(record, ["email", "password", "displayName"]);
        const email = requiredEmail(record, "email");
        const { account, token } = await accounts.signUp({
          email,
          password: requiredPassword(record, "password"),
          displayName: optionalText(record, "displayName", 128) ?? email,
        });
        // Sign-up spans two capabilities; the trial is created idempotently so
        // a failure between them heals on the first read instead of leaving an
        // account that can never provision.
        const subscription = await billing.ensureTrial(account.id);
        return { status: 201, body: { account: toAccountView(account), token: token.secret, tokenId: token.record.id, subscription } };
      },
    },
    {
      method: "POST",
      path: "/v1/accounts/sessions",
      auth: "public",
      handle: async ({ body }) => {
        const record = asRecord(body);
        rejectUnknownKeys(record, ["email", "password"]);
        const { account, token } = await accounts.signIn(requiredEmail(record, "email"), requiredText(record, "password", 256));
        return { status: 201, body: { account: toAccountView(account), token: token.secret, tokenId: token.record.id } };
      },
    },
    {
      method: "GET",
      path: "/v1/accounts/me",
      auth: "account",
      handle: async (context) => {
        const account = requireAccount(context);
        const subscription = await billing.ensureTrial(account.id);
        return { status: 200, body: { account: toAccountView(account), subscription, entitlement: await billing.entitlement(account.id) } };
      },
    },
    {
      method: "GET",
      path: "/v1/accounts/tokens",
      auth: "account",
      handle: async (context) => ({
        status: 200,
        // Digests are omitted: a token record is for revocation, not for use.
        body: {
          tokens: (await accounts.listTokens(requireAccount(context).id)).map(({ hash: _hash, ...token }) => token),
        },
      }),
    },
    {
      method: "POST",
      path: "/v1/accounts/tokens",
      auth: "account",
      handle: async (context) => {
        const record = asRecord(context.body);
        rejectUnknownKeys(record, ["name"]);
        const issued = await accounts.issueToken(requireAccount(context).id, requiredText(record, "name", 64));
        return { status: 201, body: { token: issued.secret, tokenId: issued.record.id, createdAt: issued.record.createdAt } };
      },
    },
    {
      method: "DELETE",
      path: "/v1/accounts/tokens/:tokenId",
      auth: "account",
      handle: async (context) => ({
        status: 200,
        body: { revokedAt: (await accounts.revokeToken(requireAccount(context).id, pathParam(context, "tokenId"))).revokedAt },
      }),
    },

    {
      method: "GET",
      path: "/v1/billing/plans",
      auth: "public",
      handle: async () => ({ status: 200, body: { plans: billing.listPlans() } }),
    },
    {
      method: "GET",
      path: "/v1/billing/subscription",
      auth: "account",
      handle: async (context) => {
        const accountId = requireAccount(context).id;
        return { status: 200, body: { subscription: await billing.get(accountId), entitlement: await billing.entitlement(accountId) } };
      },
    },
    {
      method: "POST",
      path: "/v1/billing/checkout",
      auth: "account",
      handle: async (context) => {
        const record = asRecord(context.body);
        rejectUnknownKeys(record, ["planId"]);
        const result = await billing.startCheckout(requireAccount(context).id, requiredText(record, "planId", 64));
        return {
          status: 201,
          // The provider's own description of what happens next travels with
          // the intent, so a provider that takes no payment cannot be
          // presented by a client as one that did.
          body: { ...result, provider: { name: billing.providerName, takesPayment: billing.takesPayment } },
        };
      },
    },
    {
      method: "POST",
      path: "/v1/billing/cancel",
      auth: "account",
      handle: async (context) => {
        const record = asRecord(context.body);
        rejectUnknownKeys(record, ["immediate"]);
        return { status: 200, body: { subscription: await billing.cancel(requireAccount(context).id, { immediate: optionalBoolean(record, "immediate") }) } };
      },
    },
    {
      method: "POST",
      path: "/v1/billing/webhook",
      auth: "public",
      handle: async ({ rawBody, headers }) => {
        // Verified by signature over the exact bytes received, not by a
        // bearer token: the provider is the caller and holds no account token.
        const signature = headers[SIGNATURE_HEADER];
        if (typeof signature !== "string") throw new UnauthorizedError(`${SIGNATURE_HEADER} is required`);
        const { applied, subscription } = await billing.applyWebhook(rawBody, signature);
        return { status: 200, body: { applied, subscription } };
      },
    },

    {
      method: "GET",
      path: "/v1/machines",
      auth: "account",
      handle: async (context) => ({ status: 200, body: { machines: await provisioning.list(requireAccount(context).id) } }),
    },
    {
      method: "POST",
      path: "/v1/machines",
      auth: "account",
      handle: async (context) => {
        const record = asRecord(context.body);
        rejectUnknownKeys(record, ["name", "image", "vcpus", "memoryMiB", "diskGiB"]);
        const vcpus = optionalInteger(record, "vcpus", 1, 64);
        const memoryMiB = optionalInteger(record, "memoryMiB", 256, 512 * 1024);
        const diskGiB = optionalInteger(record, "diskGiB", 1, 4096);
        const image = optionalText(record, "image", 128);
        const result = await provisioning.provision(requireAccount(context).id, {
          name: requiredText(record, "name", 64),
          ...(image === undefined ? {} : { image }),
          ...(vcpus === undefined ? {} : { vcpus }),
          ...(memoryMiB === undefined ? {} : { memoryMiB }),
          ...(diskGiB === undefined ? {} : { diskGiB }),
        });
        return { status: 201, body: result };
      },
    },
    {
      method: "GET",
      path: "/v1/machines/:machineId",
      auth: "account",
      handle: async (context) => ({ status: 200, body: await provisioning.describe(requireAccount(context).id, pathParam(context, "machineId")) }),
    },
    {
      method: "POST",
      path: "/v1/machines/:machineId/snapshots",
      auth: "account",
      handle: async (context) => {
        const record = asRecord(context.body);
        rejectUnknownKeys(record, ["label"]);
        return { status: 201, body: await provisioning.snapshot(requireAccount(context).id, pathParam(context, "machineId"), optionalText(record, "label", 128)) };
      },
    },
    {
      method: "POST",
      path: "/v1/machines/:machineId/restore",
      auth: "account",
      handle: async (context) => {
        const record = asRecord(context.body);
        rejectUnknownKeys(record, ["snapshotId"]);
        return { status: 200, body: await provisioning.restore(requireAccount(context).id, pathParam(context, "machineId"), requiredText(record, "snapshotId", 64)) };
      },
    },
    {
      method: "DELETE",
      path: "/v1/machines/:machineId",
      auth: "account",
      handle: async (context) => ({ status: 200, body: { machine: await provisioning.release(requireAccount(context).id, pathParam(context, "machineId")) } }),
    },

    {
      method: "POST",
      path: "/v1/registry/daemons",
      auth: "account",
      handle: async (context) => {
        const record = asRecord(context.body);
        rejectUnknownKeys(record, ["name", "version", "endpoints", "publicKey", "assignmentId"]);
        const assignmentId = optionalText(record, "assignmentId", 64);
        const registered = await registry.register(requireAccount(context).id, {
          name: requiredText(record, "name", 64),
          version: requiredText(record, "version", 32),
          endpoints: requiredStringArray(record, "endpoints", 8, 512),
          publicKey: requiredText(record, "publicKey", 1024),
          ...(assignmentId === undefined ? {} : { assignmentId }),
        });
        return { status: 201, body: { daemon: registered.daemon, heartbeatSecret: registered.secret } };
      },
    },
    {
      method: "GET",
      path: "/v1/registry/daemons",
      auth: "account",
      handle: async (context) => ({ status: 200, body: { daemons: await registry.list(requireAccount(context).id) } }),
    },
    {
      method: "POST",
      path: "/v1/registry/daemons/:daemonId/heartbeat",
      auth: "public",
      handle: async (context) => {
        // Authenticated by the daemon's own heartbeat secret rather than an
        // account token: a daemon holds no human's credentials, and a leaked
        // client token must not be able to make a dead machine look alive.
        const record = asRecord(context.body);
        rejectUnknownKeys(record, ["secret", "endpoints", "version"]);
        const endpoints = record["endpoints"] === undefined ? undefined : requiredStringArray(record, "endpoints", 8, 512);
        const version = optionalText(record, "version", 32);
        const daemon = await registry.heartbeat(pathParam(context, "daemonId"), requiredText(record, "secret", 256), {
          ...(endpoints === undefined ? {} : { endpoints }),
          ...(version === undefined ? {} : { version }),
        });
        return { status: 200, body: { daemon } };
      },
    },
    {
      method: "DELETE",
      path: "/v1/registry/daemons/:daemonId",
      auth: "account",
      handle: async (context) => {
        await registry.deregister(requireAccount(context).id, pathParam(context, "daemonId"));
        return { status: 200, body: { deregistered: true } };
      },
    },

    {
      method: "POST",
      path: "/v1/relay/tickets",
      auth: "account",
      handle: async (context) => {
        const record = asRecord(context.body);
        rejectUnknownKeys(record, ["daemonId"]);
        const issued = await relay.issue(requireAccount(context).id, requiredText(record, "daemonId", 64));
        return { status: 201, body: { ticket: issued.token, expiresAt: issued.ticket.expiresAt, daemon: issued.daemon } };
      },
    },
    {
      method: "POST",
      path: "/v1/relay/redeem",
      auth: "relay-node",
      handle: async (context) => {
        const record = asRecord(context.body);
        rejectUnknownKeys(record, ["ticket"]);
        const grant = await relay.redeem(requiredText(record, "ticket", 2048));
        return {
          status: 200,
          body: {
            accountId: grant.ticket.accountId,
            daemonId: grant.daemon.id,
            endpoints: grant.daemon.endpoints,
            publicKey: grant.daemon.publicKey,
          },
        };
      },
    },
  ];
}
