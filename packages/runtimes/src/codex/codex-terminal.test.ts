import assert from "node:assert/strict";
import test from "node:test";
import { AsyncQueue } from "@rack/core/shared/async-queue";
import { CodexRuntimeAdapter } from "./codex.js";
import type { JsonRpcMessage } from "./json-rpc-process.js";

test("Codex terminal uses standalone PTY controls, retains split Unicode and never creates a turn", async () => {
  const messages = new AsyncQueue<JsonRpcMessage>();
  const requests: Array<{ method: string; params: unknown }> = [];
  const output: string[] = [];
  const exits: number[] = [];
  let finish!: (result: unknown) => void;
  const completed = new Promise<unknown>((resolve) => { finish = resolve; });
  let closed = 0;
  let environment: NodeJS.ProcessEnv = {};
  const adapter = new CodexRuntimeAdapter({ resolve: async () => ({ environment: { TEST_CREDENTIAL: "isolated" } }) },
    { resolve: async () => ({ directory: "/context" }) }, { createProcess: (options) => {
      environment = options.environment;
      return {
        request: async (method, params) => {
          requests.push({ method, params });
          if (method === "command/exec") {
            messages.push({ method: "command/exec/outputDelta", params: { processId: "rack-terminal", deltaBase64: Buffer.from([0xe2]).toString("base64") } });
            return completed;
          }
          return {};
        },
        notify: () => {}, respond: () => {}, respondError: () => {}, nextMessage: () => messages.next(),
        close: async () => { closed++; messages.complete(); },
      };
    } });
  const terminal = await adapter.openTerminal({ cwd: "/project", cols: 80, rows: 24, onData: (text) => output.push(text), onExit: (code) => exits.push(code),
    account: { accountId: "account", providerId: "codex", credential: { id: "credential", providerId: "codex", method: "native_login" }, runtimeContextId: "context" },
  });
  messages.push({ method: "command/exec/outputDelta", params: { processId: "rack-terminal", deltaBase64: Buffer.from([0x82, 0xac]).toString("base64") } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(output.join(""), "€");
  await terminal.write("pwd\n");
  await terminal.resize(100, 30);
  assert.equal(environment["CODEX_HOME"], "/context");
  assert.equal(environment["TEST_CREDENTIAL"], "isolated");
  assert.ok(!requests.some((request) => request.method.startsWith("thread/") || request.method.startsWith("turn/")));
  const command = requests.find((request) => request.method === "command/exec")!.params as { tty: boolean; cwd: string };
  assert.equal(command.tty, true); assert.equal(command.cwd, "/project");
  const write = requests.find((request) => request.method === "command/exec/write")!.params as { deltaBase64: string };
  assert.equal(Buffer.from(write.deltaBase64, "base64").toString(), "pwd\n");
  finish({ exitCode: 4 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, [4]);
  await terminal.close(); await terminal.close();
  assert.equal(closed, 1);
});
