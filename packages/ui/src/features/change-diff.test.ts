import assert from "node:assert/strict";
import test from "node:test";
import { diffFiles, diffRows, splitDiffRows } from "./change-diff.js";

test("diff panels split files and count hunk additions/deletions without counting headers", () => {
  const files = diffFiles('diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git "a/new file.ts" "b/new file.ts"\nnew file mode 100644\n--- /dev/null\n+++ "b/new file.ts"\n@@ -0,0 +1 @@\n+created\n');
  assert.deepEqual(files.map(({ title, added, removed }) => ({ title, added, removed })), [
    { title: "app.ts", added: 1, removed: 1 }, { title: "new file.ts", added: 1, removed: 0 },
  ]);
  assert.deepEqual(diffFiles(""), []);
  assert.equal(diffFiles("diff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-deleted\n")[0]?.title, "gone.ts");
});

test("numbered diffs handle context, additions, deletions and multiple hunks", () => {
  const rows = diffRows('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -8,3 +8,4 @@ function\n same\n-old\n+new\n+extra\n tail\n@@ -22 +23 @@\n-before\n+after\n\\ No newline at end of file\n');
  assert.deepEqual(rows.filter((row) => row.kind !== "hunk" && row.kind !== "meta").map((row) => [row.kind, row.oldLine, row.newLine, row.text]), [
    ["context", 8, 8, "same"], ["removed", 9, undefined, "old"], ["added", undefined, 9, "new"], ["added", undefined, 10, "extra"],
    ["context", 10, 11, "tail"], ["removed", 22, undefined, "before"], ["added", undefined, 23, "after"],
  ]);
  assert.equal(rows.at(-1)?.kind, "meta");
  const split = splitDiffRows(rows);
  assert.equal(split[2]?.old?.text, "old");
  assert.equal(split[2]?.current?.text, "new");
  assert.equal(split[3]?.old, undefined);
  assert.equal(split[3]?.current?.text, "extra");
  assert.deepEqual(diffRows(""), []);
});
