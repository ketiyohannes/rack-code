import assert from "node:assert/strict";
import test from "node:test";
import { revealsBrowserPage } from "./agent-browser.js";

test("page changes by the agent's browser tool reveal the browser, for both runtimes", () => {
  for (const action of ["navigate", "back", "forward", "reload"]) {
    assert.ok(revealsBrowserPage({ type: "tool_request", tool: "mcp__rack__rack_browser", input: { action, url: "https://example.com" } }), `Claude ${action}`);
    assert.ok(revealsBrowserPage({ type: "tool_request", tool: "rack_browser", input: {}, mcp: { server: "rack", tool: "rack_browser", arguments: { action } } }), `Codex ${action}`);
  }
});

test("reads, in-page input and other tools do not reveal the browser", () => {
  for (const action of ["snapshot", "click", "type", "select", "press", "scroll", undefined]) {
    assert.equal(revealsBrowserPage({ type: "tool_request", tool: "mcp__rack__rack_browser", input: { action } }), false, String(action));
  }
  assert.equal(revealsBrowserPage({ type: "tool_request", tool: "Bash", input: { action: "navigate" } }), false);
  assert.equal(revealsBrowserPage({ type: "tool_request", tool: "rack_browser", input: { action: "navigate" }, mcp: { server: "other", tool: "rack_browser", arguments: { action: "navigate" } } }), false);
  assert.equal(revealsBrowserPage({ type: "tool_request", tool: "mcp__rack__rack_browser", input: null }), false);
  assert.equal(revealsBrowserPage({ type: "tool_result", output: { action: "navigate" } }), false);
});
