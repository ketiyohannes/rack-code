import assert from "node:assert/strict";
import test from "node:test";
import { AccountsService } from "../accounts/service.js";
import { InMemoryAccountStore } from "../accounts/in-memory-store.js";
import { ConnectionsService } from "./service.js";
import type { AccountConnector } from "./ports.js";

test("existing login contexts persist across registration; private connections keep fresh contexts", async () => {
  const accounts = new AccountsService(new InMemoryAccountStore());
  const seen: string[] = [];
  const connector: AccountConnector = { providerId: "fake", displayName: "Fake", existingRuntimeContextId: "local-login",
    connect: (context) => {
      seen.push(context.runtimeContextId);
      return { events: (async function* () { yield { type: "completed" as const, identity: { providerAccountId: "user" } }; })(),
        submitCode: () => undefined, cancel: async () => undefined };
    } };
  let sequence = 0;
  const service = new ConnectionsService(accounts, { resolve: async () => ({ directory: "/context" }) }, [connector], { createId: () => String(++sequence) });
  assert.equal(service.providers()[0]?.supportsExistingLogin, true);
  const completed = () => new Promise<void>((resolve) => {
    const unsubscribe = service.subscribe((view) => { if (view.status === "completed") { unsubscribe(); resolve(); } });
  });
  let done = completed();
  const view = await service.connect({ providerId: "fake", useExistingLogin: true });
  assert.equal(view.useExistingLogin, true);
  await done;
  assert.equal((await accounts.list())[0]?.runtimeContextId, "local-login");
  done = completed();
  await service.connect({ providerId: "fake" });
  await done;
  assert.ok(seen[1]?.startsWith("ctx-"));
  assert.equal((await accounts.list()).length, 1);
  assert.equal((await accounts.list())[0]?.runtimeContextId, seen[1]);
});

test("unsupported existing-login requests never launch a connector", async () => {
  const service = new ConnectionsService(new AccountsService(new InMemoryAccountStore()),
    { resolve: async () => { throw new Error("must not resolve"); } },
    [{ providerId: "fake", displayName: "Fake", connect: () => { throw new Error("must not launch"); } }]);
  await assert.rejects(service.connect({ providerId: "fake", useExistingLogin: true }), /does not support/);
});
