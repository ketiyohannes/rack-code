import assert from "node:assert/strict";
import test from "node:test";
import { BrowserService, browserUrl, type BrowserRequest } from "./index.js";

test("browser URLs normalize web addresses and reject privileged schemes and embedded credentials", () => {
  assert.equal(browserUrl("example.com"), "https://example.com/");
  assert.equal(browserUrl("http://localhost:3000/page"), "http://localhost:3000/page");
  for (const url of ["file:///etc/passwd", "javascript://alert(1)", "data://text/html,hello", "https://user:secret@example.com", "chrome://settings"]) assert.throws(() => browserUrl(url));
});

test("browser checks session existence before the driver and reserves lifecycle controls for the user", async () => {
  const requests: BrowserRequest[] = [];
  const service = new BrowserService(async (id) => { if (id !== "saved") throw new Error("Session not found"); }, { control: async (_id, request) => {
    requests.push(request);
    return { url: "", title: "", loading: false, canGoBack: false, canGoForward: false, agentEnabled: true };
  } });
  await assert.rejects(service.control("missing", { action: "state" }), /not found/);
  for (const action of ["agent", "close"] as const) await assert.rejects(service.control("saved", { action, actor: "agent" }), /Only the user/);
  assert.equal(requests.length, 0);
  await service.control("saved", { action: "snapshot", actor: "agent" });
  await service.control("saved", { action: "agent", enabled: false });
  assert.deepEqual(requests.map((request) => request.action), ["snapshot", "agent"]);
});
