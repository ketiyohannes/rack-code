import assert from "node:assert/strict";
import test from "node:test";
import { importedTool, presentTool } from "./tool-presentation.js";

test("command cards extract readable output, duration and exit status", () => {
  const view = presentTool({ kind: "tool", tool: "commandExecution", input: { command: "npm test", cwd: "/project" },
    hasOutput: true, finished: true, output: { aggregatedOutput: "2 tests passed", durationMs: 1250, exitCode: 0 } }, false);
  assert.equal(view.title, "Run command");
  assert.equal(view.subtitle, "npm test");
  assert.equal(view.status, "Completed");
  assert.equal(view.duration, "1.3 s");
  assert.deepEqual(view.sections.map((section) => section.label), ["Command", "Directory", "Output"]);
  assert.equal(view.sections[2]?.text, "2 tests passed");
});

test("diffs and failures get useful displays and incomplete calls never claim success", () => {
  const item = { kind: "tool" as const, tool: "fileChange", input: { changes: [{ path: "app.ts", diff: "@@\n-old\n+new" }] }, hasOutput: false, finished: false };
  assert.equal(presentTool(item, true).status, "Running");
  const saved = presentTool(item, false);
  assert.equal(saved.status, "Incomplete");
  assert.equal(saved.sections[0]?.format, "diff");
  assert.equal(saved.sections[0]?.label, "app.ts");
  assert.equal(presentTool({ ...item, hasOutput: true, finished: true, isError: true }, false).status, "Failed");
});

test("imported structured tools use the same layout without pretending pending work completed", () => {
  const item = importedTool(JSON.stringify({ type: "Bash", input: { command: "git status" }, output: "clean", status: "completed" }));
  const view = presentTool(item, false);
  assert.equal(view.title, "Run command");
  assert.equal(view.sections.at(-1)?.text, "clean");
  assert.equal(presentTool(importedTool(JSON.stringify({ type: "Bash", input: {}, status: "inProgress" })), false).status, "Incomplete");
});
