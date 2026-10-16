import assert from "node:assert/strict";
import test from "node:test";
import { importedTool, presentTool } from "./tool-presentation.js";

test("empty ripgrep results are non-error outcomes without changing native exit codes", () => {
  for (const command of ["rg -n missing src", "rg.exe missing src", "/usr/bin/rg missing src",
    '"C:\\Tools\\rg.exe" missing src', 'powershell.exe -Command "rg -n missing src"',
    '"C:\\Windows\\powershell.exe" -Command "rg missing src"', "/bin/zsh -lc 'rg missing src'"]) {
    const item = { kind: "tool" as const, tool: "commandExecution", input: { command },
      finished: true, hasOutput: true, isError: true, output: { exitCode: 1, status: "failed", aggregatedOutput: "" } };
    const view = presentTool(item, false);
    assert.equal(view.status, "No matches", command);
    assert.equal(view.exitCode, 1);
    assert.equal(view.sections.at(-1)?.text, "No matches");
    assert.equal(item.isError, true);
    assert.equal(presentTool({ ...item, finished: false }, true).status, "Running");
    assert.equal(presentTool(importedTool(JSON.stringify({ ...item.output, command, type: "commandExecution" })), false).status, "No matches");
  }
});

test("real errors and ambiguous shell batches stay failures", () => {
  for (const [command, output] of [
    ["rg missing src", { exitCode: 2, aggregatedOutput: "" }],
    ["rg missing src", { exitCode: 1, aggregatedOutput: "regex parse error" }],
    ["rg missing src", { exitCode: 1, aggregatedOutput: "", stderr: "access denied" }],
    ["rg missing src", { exitCode: 1 }],
    ["rg missing src", { exitCode: 1, aggregatedOutput: "", status: "declined" }],
    ["npm test", { exitCode: 1, aggregatedOutput: "" }],
    ["git diff; rg missing src", { exitCode: 1, aggregatedOutput: "" }],
    ['powershell.exe -Command "git diff; rg missing src"', { exitCode: 1, aggregatedOutput: "" }],
    ["rg missing src | other-command", { exitCode: 1, aggregatedOutput: "" }],
    ["rg $(other-command) src", { exitCode: 1, aggregatedOutput: "" }],
  ] as const) {
    assert.equal(presentTool({ kind: "tool", tool: "commandExecution", input: { command },
      finished: true, hasOutput: true, isError: true, output }, false).status, "Failed", command);
  }
});

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
