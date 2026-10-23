import assert from "node:assert/strict";
import test from "node:test";

import {
  AccountProviderMismatchError,
  AccountsService,
  DuplicateAccountError,
  InMemoryAccountStore,
} from "./index.js";

const fixedNow = new Date("2026-10-12T00:00:00.000Z");

function createService() {
  let id = 0;
  return new AccountsService(new InMemoryAccountStore(), {
    now: () => fixedNow,
    createId: () => `account-${++id}`,
  });
}

function registration(providerAccountId: string, providerId = "claude") {
  return {
    providerId,
    identity: { providerAccountId },
    credential: {
      id: `credential-${providerAccountId}`,
      providerId,
      method: "subscription-oauth",
    },
    runtimeContextId: `runtime-${providerAccountId}`,
  };
}

test("registers accounts without accepting credential material", async () => {
  const service = createService();

  const account = await service.register(registration("personal"));

  assert.equal(account.id, "account-1");
  assert.equal(account.providerId, "claude");
  assert.equal(account.credential.id, "credential-personal");
  assert.equal(account.credential.method, "subscription-oauth");
  assert.equal("secret" in account.credential, false);
});

test("rejects duplicate provider identities but permits the same identity under another provider", async () => {
  const service = createService();

  await service.register(registration("same-user"));
  await assert.rejects(
    service.register(registration("same-user")),
    DuplicateAccountError,
  );

  const codexAccount = await service.register(registration("same-user", "codex"));
  assert.equal(codexAccount.providerId, "codex");
});

test("selects accounts per provider and rejects cross-provider selection", async () => {
  const service = createService();
  const claude = await service.register(registration("claude-user"));
  const codex = await service.register(registration("codex-user", "codex"));

  await service.select("claude", claude.id);
  assert.equal((await service.selected("claude"))?.id, claude.id);
  assert.equal(await service.selected("codex"), undefined);

  await assert.rejects(
    service.select("claude", codex.id),
    AccountProviderMismatchError,
  );
});

test("prefers the selected available account and fails over to another available account", async () => {
  const service = createService();
  const first = await service.register(registration("first"));
  const second = await service.register(registration("second"));

  await service.updateAvailability(first.id, { status: "available" });
  await service.updateAvailability(second.id, { status: "available" });
  await service.select("claude", first.id);
  assert.equal((await service.chooseEligible("claude"))?.id, first.id);

  await service.updateAvailability(first.id, {
    status: "unavailable",
    reason: "quota exhausted",
  });
  assert.equal((await service.chooseEligible("claude"))?.id, second.id);
});

test("returns no eligible account until an adapter reports availability", async () => {
  const service = createService();
  await service.register(registration("unknown"));

  assert.equal(await service.chooseEligible("claude"), undefined);
});

test("clears stale availability details when a later observation omits them", async () => {
  const service = createService();
  const account = await service.register(registration("tracked"));

  await service.updateAvailability(account.id, {
    status: "unavailable",
    reason: "rate limited",
    quotaResetAt: "2026-10-13T00:00:00.000Z",
  });
  const available = await service.updateAvailability(account.id, {
    status: "available",
  });

  assert.equal(available.availability, "available");
  assert.equal(available.availabilityReason, undefined);
  assert.equal(available.quotaResetAt, undefined);
});

test("marks the account used without changing its provider identity", async () => {
  const service = createService();
  const account = await service.register(registration("used"));

  const updated = await service.markUsed(account.id);

  assert.equal(updated.providerId, account.providerId);
  assert.equal(updated.identity.providerAccountId, "used");
  assert.equal(updated.lastUsedAt, fixedNow.toISOString());
});

test("reauthenticates an account by replacing only opaque references and clearing stale availability", async () => {
  const service = createService();
  const account = await service.register(registration("reauth"));
  await service.updateAvailability(account.id, {
    status: "unavailable",
    reason: "expired",
    quotaResetAt: "2026-10-13T00:00:00.000Z",
  });

  const updated = await service.reauthenticate(account.id, {
    credential: { id: "credential-reauth", providerId: "claude", method: "subscription-oauth" },
    runtimeContextId: "runtime-reauth",
  });

  assert.equal(updated.credential.id, "credential-reauth");
  assert.equal(updated.runtimeContextId, "runtime-reauth");
  assert.equal(updated.availability, "unknown");
  assert.equal(updated.availabilityReason, undefined);
  assert.equal(updated.quotaResetAt, undefined);
});

test("returns defensive copies from the store", async () => {
  const service = createService();
  const account = await service.register(registration("immutable"));

  const first = await service.get(account.id);
  (first.identity as { displayName?: string }).displayName = "changed outside service";

  const second = await service.get(account.id);
  assert.equal(second.identity.displayName, undefined);
});

