import assert from "node:assert/strict";
import test from "node:test";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeRunInput } from "@rack/core/execution/types";
import { ClaudeRuntimeAdapter } from "../claude/claude.js";
import { CodexRuntimeAdapter } from "../codex/codex.js";

const input = (mode: RuntimeRunInput["permissionMode"]): RuntimeRunInput => ({
  runId: "run", attemptId: "attempt", sessionId: "session", projectPath: "/project", prompt: "test", permissionMode: mode,
  account: { accountId: "account", providerId: "test", credential: { id: "credential", providerId: "test", method: "native_login" }, runtimeContextId: "context" },
  signal: new AbortController().signal, requestApproval: async () => "allow",
  tools: [{ name: "rack_browser", description: "Shared browser", inputSchema: { type: "object" }, execute: async () => "page result" }],
});

async function callTool(server: { url: string; headers?: Record<string, string>; http_headers?: Record<string, string> }): Promise<void> {
  const response = await fetch(server.url, { method: "POST", headers: { ...server.headers, ...server.http_headers, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rack_browser", arguments: { action: "snapshot" } } }),
  });
  const result = await response.json() as { result: { content: Array<{ text: string }> } };
  assert.equal(result.result.content[0]?.text, "page result");
}

test("Claude exposes run-scoped tools on start/resume and preserves native automatic review", async () => {
  for (const mode of ["ask", "approve_for_me", "read_only", "full_access"] as const) {
    let url = "";
    const adapter = new ClaudeRuntimeAdapter({ resolve: async () => ({ environment: {} }) }, { resolve: async () => ({ directory: "/context" }) },
      (({ options }: { options: Options }) => ({ async *[Symbol.asyncIterator]() {
        const server = options.mcpServers?.["rack"] as { type: string; url: string; headers: Record<string, string> };
        assert.equal(server.type, "http"); url = server.url;
        assert.equal(options.allowedTools?.includes("mcp__rack__rack_browser") === true, mode !== "approve_for_me");
        await callTool(server);
        yield { type: "result", subtype: "success", result: "done" };
      }, close: () => {} })) as unknown as typeof query);
    for (const resume of [false, true]) {
      const run = { ...input(mode), ...(resume ? { continuation: { nativeSessionId: "native" } } : {}) };
      for await (const _event of resume ? adapter.resumeRun(run) : adapter.startRun(run)) { /* Drain to exercise cleanup. */ }
      await assert.rejects(fetch(url));
    }
  }
});

test("Codex configures authenticated MCP on fresh and resumed threads and closes it after the turn", async () => {
  let url = "";
  const methods: string[] = [];
  const adapter = new CodexRuntimeAdapter({ resolve: async () => ({ environment: {} }) }, { resolve: async () => ({ directory: "/context" }) }, { createProcess: () => ({
    request: async (method, params) => {
      methods.push(method);
      if (method === "thread/start" || method === "thread/resume") {
        const server = (params as { config: { mcp_servers: { rack: { url: string; http_headers: Record<string, string> } } } }).config.mcp_servers.rack;
        url = server.url; await callTool(server);
        return { thread: { id: "thread" } };
      }
      return method === "turn/start" ? { turn: { id: "turn" } } : {};
    },
    notify: () => {}, respond: () => {}, respondError: () => {}, close: async () => {},
    nextMessage: async () => ({ done: false, value: { method: "turn/completed", params: { turn: { status: "completed" } } } }),
  }) });
  for (const resume of [false, true]) {
    const run = { ...input("full_access"), ...(resume ? { continuation: { nativeSessionId: "native" } } : {}) };
    for await (const _event of resume ? adapter.resumeRun(run) : adapter.startRun(run)) { /* Drain to exercise cleanup. */ }
    await assert.rejects(fetch(url));
  }
  assert.ok(methods.includes("thread/start")); assert.ok(methods.includes("thread/resume"));
});
