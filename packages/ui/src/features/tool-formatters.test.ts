import assert from "node:assert/strict";
import test from "node:test";

import { applyTimedEvent, EMPTY_TURN, type ToolCall } from "./turn-activity.js";
import { createDefaultRegistry, toolCallContext } from "./tool-formatters.js";
import { releaseEventLog, RELEASE_APPROVAL, RELEASE_FINAL_ROWS } from "./fixtures/release-blocker.js";

const registry = createDefaultRegistry();
const resolve = (call: Parameters<typeof toolCallContext>[0]) => registry.resolve(toolCallContext(call));

test("the release scenario rows read as specified, in every tense", () => {
  const state = releaseEventLog().reduce((current, { event, at }) => applyTimedEvent(current, event, at), EMPTY_TURN);
  const calls = Object.values(state.groups)[0]!.callIds.map((id) => state.calls[id]!);
  const rows = calls.map((call: ToolCall) => {
    const format = resolve({ tool: call.tool, input: call.input, ...(call.mcp === undefined ? {} : { mcp: call.mcp }), output: call.output, isError: false });
    return { label: format.label("past"), summary: format.summary };
  });
  assert.deepEqual(rows, RELEASE_FINAL_ROWS.map(({ label, summary }) => ({ label, summary })));
  const search = calls[0]!;
  assert.equal(resolve({ tool: search.tool, input: search.input, mcp: search.mcp!, isError: false }).label("present"), "Searching issues in arc-ui/web");
  const post = calls[3]!;
  assert.deepEqual(resolve({ tool: post.tool, input: post.input, mcp: post.mcp!, isError: false }).approval, RELEASE_APPROVAL);
});

test("the same MCP call reads the same from Claude and Codex shapes", () => {
  const args = { owner: "arc-ui", repo: "web", state: "open" };
  const claude = resolve({ tool: "mcp__github__list_issues", input: args, mcp: { server: "github", tool: "list_issues", arguments: args }, isError: false });
  const codex = resolve({ tool: "mcpToolCall", input: { type: "mcpToolCall", id: "x", server: "github", tool: "list_issues", arguments: args },
    mcp: { server: "github", tool: "list_issues", arguments: args }, isError: false });
  assert.equal(claude.label("present"), "Listing issues in arc-ui/web");
  assert.equal(codex.label("past"), "Listed issues in arc-ui/web");
  assert.equal(claude.icon, "brand-github");
  assert.equal(codex.icon, "brand-github");
  // Codex nests results under `result`; Claude passes content blocks. Both count.
  const codexResult = resolve({ tool: "mcpToolCall", input: {}, mcp: { server: "github", tool: "list_issues" }, isError: false,
    output: { type: "mcpToolCall", result: { content: [{ type: "text", text: "[1,2,3]" }] } } });
  const claudeResult = resolve({ tool: "mcp__github__list_issues", input: {}, mcp: { server: "github", tool: "list_issues" }, isError: false,
    output: [{ type: "text", text: "[1,2,3]" }] });
  assert.equal(codexResult.summary, "3 results");
  assert.equal(claudeResult.summary, "3 results");
});

test("unknown tools fall back to 'Ran <tool>' with their first argument", () => {
  const format = resolve({ tool: "lookupUser", input: { login: "alice", verbose: true }, isError: false });
  assert.equal(format.label("past"), "Ran Lookup user: alice");
  assert.equal(format.label("present"), "Running Lookup user: alice");
  assert.equal(format.icon, "wrench-fill");
  const unknownMcp = resolve({ tool: "mcp__acme__frobnicate", input: {}, mcp: { server: "acme", tool: "frobnicate" }, isError: false });
  assert.equal(unknownMcp.label("past"), "Ran Frobnicate");
  assert.equal(unknownMcp.approval.consequence, "Calls frobnicate on the acme server");
});

test("built-in tools are recognized by shape on any runtime", () => {
  const claudeShell = resolve({ tool: "Bash", input: { command: "npm test" }, output: "ok\nok\n", isError: false });
  const codexShell = resolve({ tool: "commandExecution", input: { type: "commandExecution", command: "npm test", cwd: "/repo" }, isError: false });
  assert.equal(claudeShell.label("past"), "Ran npm test");
  assert.equal(claudeShell.summary, "2 lines");
  assert.equal(codexShell.label("present"), "Running npm test");
  assert.deepEqual(codexShell.approval, { action: "Run npm test", consequence: "Runs in /repo" });
  assert.equal(resolve({ tool: "Read", input: { file_path: "/repo/src/app.ts" }, isError: false }).label("past"), "Read app.ts");
  assert.equal(resolve({ tool: "fileChange", input: { changes: [{ path: "a.ts" }, { path: "b.ts" }] }, isError: false }).label("past"), "Edited 2 files");
  assert.equal(resolve({ tool: "Grep", input: { pattern: "TODO" }, output: "a.ts:1\nb.ts:2", isError: false }).summary, "2 matches");
});

test("failed calls read as 'Could not <action>' with the error as their summary", () => {
  const failed = resolve({ tool: "mcp__postgres__query", input: {}, isError: true,
    mcp: { server: "postgres", tool: "query", arguments: { sql: "select * from pending_migrations" } },
    output: [{ type: "text", text: "Connection to app_production timed out after 5s" }] });
  assert.equal(failed.label("failed"), "Could not query pending migrations");
  assert.equal(failed.summary, "Connection to app_production timed out after 5s");
  assert.equal(failed.icon, "brand-postgres");
  assert.equal(resolve({ tool: "lookupUser", input: { login: "alice" }, isError: true }).label("failed"), "Could not run Lookup user: alice");
});

test("failures summarize the error, and a provider reason becomes the consequence", () => {
  const failed = resolve({ tool: "commandExecution", input: { command: "make" }, output: { exitCode: 2 }, isError: true });
  assert.equal(failed.summary, "exit 2");
  const mcpError = resolve({ tool: "mcpToolCall", input: {}, mcp: { server: "linear", tool: "get_project" }, output: { error: { message: "Project not found\nstack..." } }, isError: true });
  assert.equal(mcpError.summary, "Project not found");
  const reasoned = resolve({ tool: "item/fileChange/requestApproval", input: { itemId: "x" }, reason: "Writes outside the workspace", isError: false });
  assert.equal(reasoned.approval.consequence, "Writes outside the workspace");
  // A provider reason also replaces a consequence derived from arguments.
  const explained = resolve({ tool: "commandExecution", input: { command: "rm -rf build", cwd: "/repo" }, reason: "Deletes build output", isError: false });
  assert.deepEqual(explained.approval, { action: "Run rm -rf build", consequence: "Deletes build output" });
});

test("registered formatters override fallbacks without touching other tools", () => {
  const custom = createDefaultRegistry().registerTool("acme", "deploy", {
    icon: "cloud-arrow-up",
    label: (call, tense) => `${tense === "past" ? "Deployed" : tense === "present" ? "Deploying" : "Deploy"} ${String(call.args.env)}`,
  });
  const format = custom.resolve(toolCallContext({ tool: "mcp__acme__deploy", input: {}, mcp: { server: "acme-mcp", tool: "deploy", arguments: { env: "staging" } }, isError: false }));
  assert.equal(format.label("past"), "Deployed staging");
  assert.equal(format.icon, "cloud-arrow-up");
});

test("shell commands get the icon of the program they run, past setup and wrappers", () => {
  // The command this branch was pushed with, as the agent's shell tool sent it.
  const push = "cd /Users/me/rack-code && git -c credential.helper= push -u origin feat/tool-group-cards 2>&1 | tail -3";
  assert.equal(resolve({ tool: "Bash", input: { command: push }, isError: false }).icon, "brand-git");
  assert.equal(resolve({ tool: "Bash", input: { command: push }, isError: false }).label("past"), "Ran git -c credential.helper= push -u origin feat/tool-group-ca...");
  // Codex wraps commands in a login shell; the wrapped program decides.
  assert.equal(resolve({ tool: "commandExecution", input: { command: "/bin/zsh -lc 'npm test'" }, isError: false }).icon, "brand-npm");
  assert.equal(resolve({ tool: "Bash", input: { command: "FOO=1 sudo docker compose up" }, isError: false }).icon, "brand-docker");
  assert.equal(resolve({ tool: "Bash", input: { command: "gh pr view 12" }, isError: false }).icon, "brand-github");
  assert.equal(resolve({ tool: "Bash", input: { command: "cd src" }, isError: false }).icon, "terminal-window-fill");
  assert.equal(resolve({ tool: "Bash", input: { command: "make build" }, isError: false }).icon, "terminal-window-fill");
});

test("a command's own description is its label", () => {
  const format = resolve({ tool: "Bash", input: { command: "git push", description: "Push the feature branch" }, isError: false });
  assert.equal(format.label("present"), "Push the feature branch");
  assert.equal(format.label("failed"), "Could not push the feature branch");
  assert.deepEqual(format.approval, { action: "Push the feature branch", consequence: "git push" });
});

test("file reads and edits get the icon of the file type", () => {
  assert.equal(resolve({ tool: "Read", input: { file_path: "/repo/src/app.ts" }, isError: false }).icon, "brand-typescript");
  assert.equal(resolve({ tool: "Edit", input: { file_path: "/repo/docs/README.md", old_string: "a", new_string: "b" }, isError: false }).icon, "brand-markdown");
  assert.equal(resolve({ tool: "Read", input: { file_path: "/repo/Dockerfile" }, isError: false }).icon, "brand-docker");
  assert.equal(resolve({ tool: "fileChange", input: { changes: [{ path: "main.py" }] }, isError: false }).icon, "brand-python");
  assert.equal(resolve({ tool: "fileChange", input: { changes: [{ path: "a.py" }, { path: "b.ts" }] }, isError: false }).icon, "pencil-simple-fill");
  assert.equal(resolve({ tool: "Read", input: { file_path: "/repo/notes.unknownext" }, isError: false }).icon, "file-text-fill");
});

test("well-known MCP servers show their brand mark", () => {
  const icon = (server: string) => resolve({ tool: `mcp__${server}__search`, input: {}, mcp: { server, tool: "search" }, isError: false }).icon;
  assert.deepEqual(["notion", "figma", "sentry", "google-drive", "unknown-thing"].map(icon), ["brand-notion", "brand-figma", "brand-sentry", "brand-google-drive", "plugs-fill"]);
});
