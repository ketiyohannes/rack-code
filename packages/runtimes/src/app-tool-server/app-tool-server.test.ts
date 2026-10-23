import assert from "node:assert/strict";
import test from "node:test";
import { startAppToolServer } from "./app-tool-server.js";

test("run tools negotiate MCP, authenticate requests and return bounded tool errors", async () => {
  const controller = new AbortController();
  const calls: unknown[] = [];
  const server = await startAppToolServer([{
    name: "rack_browser", description: "Shared browser", inputSchema: { type: "object" },
    execute: async (args) => { calls.push(args); if ((args as { fail?: boolean }).fail) throw new Error("Paused"); return "héllo"; },
  }], controller.signal);
  assert.ok(server);
  try {
    const rpc = async (method: string, params?: unknown) => {
      const response = await fetch(server.url, { method: "POST", headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      assert.equal(response.status, 200);
      return await response.json() as { result: { protocolVersion?: string; tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text: string }> }; error?: { code: number } };
    };
    assert.equal((await fetch(server.url, { method: "POST" })).status, 403);
    assert.equal((await fetch(server.url, { method: "POST", headers: { Authorization: `Bearer ${server.token}`, Origin: "https://example.com" } })).status, 403);
    assert.equal((await rpc("initialize", { protocolVersion: "2025-03-26" })).result.protocolVersion, "2025-03-26");
    assert.deepEqual((await rpc("tools/list")).result.tools?.map((tool) => tool.name), ["rack_browser"]);
    assert.equal((await rpc("tools/call", { name: "rack_browser", arguments: { text: "é" } })).result.content?.[0]?.text, "héllo");
    assert.deepEqual(calls[0], { text: "é" });
    assert.equal((await rpc("tools/call", { name: "rack_browser", arguments: { fail: true } })).result.isError, true);
    assert.equal((await rpc("unknown")).error?.code, -32601);
    const notification = await fetch(server.url, { method: "POST", headers: { Authorization: `Bearer ${server.token}` }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    assert.equal(notification.status, 202);
  } finally { await server.close(); await server.close(); }
});

test("run cancellation closes its tool listener and empty/aborted runs never open one", async () => {
  const controller = new AbortController();
  assert.equal(await startAppToolServer([], controller.signal), undefined);
  controller.abort();
  const tools = [{ name: "test", description: "test", inputSchema: {}, execute: async () => "ok" }];
  await assert.rejects(startAppToolServer(tools, controller.signal), /interrupted/);
  const running = new AbortController();
  const server = await startAppToolServer(tools, running.signal);
  assert.ok(server);
  running.abort();
  await server.close();
  await assert.rejects(fetch(server.url));
});
