import assert from "node:assert/strict";
import test from "node:test";
import { collectRunChanges } from "./run-changes.js";
import type { TranscriptItem } from "../transcript.js";

const tool = (tool: string, input: unknown, output: unknown = {}, extra: Partial<Extract<TranscriptItem, { kind: "tool" }>> = {}): TranscriptItem =>
  ({ kind: "tool", tool, input, output, hasOutput: true, finished: true, ...extra });

test("Codex file changes keep unified diff rows with line numbers", () => {
  const [file] = collectRunChanges([tool("fileChange", {}, { changes: [{ path: "src/a.ts", kind: { type: "update" },
    diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3,2 +3,2 @@\n keep\n-old\n+new\n" }] })]);
  assert.equal(file?.path, "src/a.ts");
  assert.equal(file?.status, "modified");
  assert.deepEqual([file?.additions, file?.deletions], [1, 1]);
  assert.deepEqual(file?.rows.find((row) => row.kind === "added"), { kind: "added", text: "new", newLine: 4 });
});

test("added and deleted Codex files reported as plain content are counted", () => {
  const files = collectRunChanges([tool("fileChange", {}, { changes: [
    { path: "new.ts", kind: "add", diff: "one\ntwo\n" }, { path: "gone.ts", kind: { type: "delete" }, diff: "x\n" }] })]);
  assert.deepEqual(files.map((file) => [file.path, file.status, file.additions, file.deletions]), [["new.ts", "added", 2, 0], ["gone.ts", "deleted", 0, 1]]);
});

test("Claude edits aggregate per file, without invented line numbers", () => {
  const files = collectRunChanges([
    tool("Write", { file_path: "b.ts", content: "a\nb" }),
    tool("Edit", { file_path: "b.ts", old_string: "a", new_string: "c" }),
    tool("MultiEdit", { file_path: "c.ts", edits: [{ old_string: "1", new_string: "2" }, { old_string: "3", new_string: "4\n5" }] }),
  ]);
  assert.deepEqual(files.map((file) => [file.path, file.status, file.additions, file.deletions]), [["b.ts", "added", 3, 1], ["c.ts", "modified", 3, 2]]);
  assert.equal(files[0]!.rows.every((row) => row.oldLine === undefined && row.newLine === undefined), true);
});

test("failed, declined, unfinished and non-edit tools are not reported as changes", () => {
  assert.deepEqual(collectRunChanges([
    tool("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }, {}, { isError: true }),
    tool("fileChange", {}, { status: "declined", changes: [{ path: "b.ts", diff: "@@ -1 +1 @@\n-a\n+b" }] }),
    tool("Edit", { file_path: "c.ts", old_string: "a", new_string: "b" }, undefined, { finished: false, hasOutput: false }),
    tool("Read", { file_path: "d.ts" }),
    { kind: "text", text: "done" },
  ]), []);
});
