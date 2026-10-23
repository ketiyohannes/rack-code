import assert from "node:assert/strict";
import test from "node:test";
import { AccountsService } from "../accounts/service.js";
import { InMemoryAccountStore } from "../accounts/in-memory-store.js";
import { ConnectionsService } from "./service.js";
import type { ConnectContext, ProviderDiagnostic } from "./ports.js";

test("checks validate account ownership, coalesce requests and leave account records unchanged", async () => {
  const accounts = new AccountsService(new InMemoryAccountStore());
  const account = await accounts.register({ providerId: "fake", identity: { providerAccountId: "user" },
    credential: { id: "credential", providerId: "fake", method: "native_login" }, runtimeContextId: "private-context" });
  const before = await accounts.get(account.id);
  const contexts: string[] = [];
  let calls = 0;
  let finish!: (result: ProviderDiagnostic) => void;
  const result: ProviderDiagnostic = { status: "ready", stage: "startup", message: "Ready", authentication: "not_checked", checkedAt: new Date().toISOString() };
  const service = new ConnectionsService(accounts, { resolve: async (id) => { contexts.push(id); return { directory: "/isolated" }; } }, [
    { providerId: "fake", displayName: "Fake", connect: () => { throw new Error("must not sign in"); },
      diagnose: async (context?: ConnectContext) => {
        calls++; assert.equal(context?.runtimeContextId, "private-context");
        return new Promise<ProviderDiagnostic>((resolve) => { finish = resolve; });
      } },
    { providerId: "other", displayName: "Other", connect: () => { throw new Error("must not sign in"); } },
  ]);
  await assert.rejects(service.diagnose({ providerId: "other", accountId: account.id }));
  await assert.rejects(service.diagnose({ providerId: "missing" }));
  assert.deepEqual(contexts, []);
  const first = service.diagnose({ providerId: "fake", accountId: account.id });
  const second = service.diagnose({ providerId: "fake", accountId: account.id });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1); finish(result);
  assert.deepEqual(await Promise.all([first, second]), [result, result]);
  assert.deepEqual(contexts, ["private-context"]);
  assert.deepEqual(await accounts.get(account.id), before);
  assert.deepEqual(service.active(), []);
});
