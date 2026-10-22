import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeConnector } from "./claude-connector.js";
import { CodexConnector } from "./codex-connector.js";
import { JsonRpcProcess } from "../runtimes/json-rpc-process.js";

const context = { runtimeContextId: "local-claude-login", directory: process.cwd(), environment: { ANTHROPIC_API_KEY: "secret" } };

test("existing Claude login reads safe identity without interactive login or credential copying", async () => {
  const connector = new ClaudeConnector(process.execPath, async (_command, args, cwd, env) => {
    assert.deepEqual(args, ["auth", "status", "--json"]);
    assert.equal(cwd, context.directory);
    assert.equal(env.CLAUDE_CONFIG_DIR, context.directory);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    return { code: 0, stdout: JSON.stringify({ loggedIn: true, accountUuid: "id", email: "user@example.com", token: "secret" }) };
  });
  const events = [];
  for await (const event of connector.connect(context).events) events.push(event);
  assert.deepEqual(events, [{ type: "completed", identity: { providerAccountId: "id", email: "user@example.com" } }]);
});

test("existing login reports sanitized failures and cancellation prevents completion", async () => {
  const connector = new ClaudeConnector(process.execPath, async () => { throw new Error("SECRET"); });
  const events = [];
  for await (const event of connector.connect(context).events) events.push(event);
  assert.equal(events[0]?.type, "failed");
  assert.ok(!JSON.stringify(events).includes("SECRET"));
  const attempt = connector.connect(context);
  await attempt.cancel();
  const cancelled = [];
  for await (const event of attempt.events) cancelled.push(event);
  assert.deepEqual(cancelled, []);
});

test("existing Codex login never starts OAuth or refreshes tokens", async () => {
  const methods: string[] = [];
  const connector = new CodexConnector({ createProcess: () => ({
    request: async (method: string, params: unknown) => {
      methods.push(method);
      if (method === "account/read") {
        assert.deepEqual(params, { refreshToken: false });
        return { account: { type: "chatgpt", email: "user@example.com" } };
      }
      return {};
    }, notify: () => undefined, close: async () => undefined,
  }) as unknown as JsonRpcProcess });
  const attempt = connector.connect({ ...context, runtimeContextId: "local-codex-login" });
  const events = [];
  for await (const event of attempt.events) events.push(event);
  await attempt.cancel();
  assert.deepEqual(methods, ["initialize", "account/read"]);
  assert.equal(events[0]?.type, "completed");
});
