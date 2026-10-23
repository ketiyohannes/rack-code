import assert from "node:assert/strict";
import test from "node:test";
import { patchFiles, statusFiles } from "./git-status.js";

test("NUL status preserves both halves of staged edits, renames and unusual names", () => {
  const files = statusFiles('MM src/app.ts\0R  src/new name.ts\0src/old name.ts\0?? src/line\nbreak.txt\0UU src/conflict.ts\0 D src/gone.ts\0?? outside.ts\0', 'src/');
  assert.deepEqual(files.map(({ path, status, group, previousPath }) => ({ path, status, group, previousPath })), [
    { path: 'app.ts', status: 'modified', group: 'staged', previousPath: undefined },
    { path: 'app.ts', status: 'modified', group: 'changes', previousPath: undefined },
    { path: 'new name.ts', status: 'renamed', group: 'staged', previousPath: 'old name.ts' },
    { path: 'line\nbreak.txt', status: 'untracked', group: 'changes', previousPath: undefined },
    { path: 'conflict.ts', status: 'conflicted', group: 'conflicts', previousPath: undefined },
    { path: 'gone.ts', status: 'deleted', group: 'changes', previousPath: undefined },
  ]);
  assert.equal(statusFiles('R  outside.ts\0src/old.ts\0', 'src/')[0]?.status, 'deleted');
});

test("patch indexing uses source paths for deletion and handles C-escaped/new names", () => {
  const diff = 'diff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n'
    + 'diff --git "a/line\\nbreak.ts" "b/line\\nbreak.ts"\n--- "a/line\\nbreak.ts"\n+++ "b/line\\nbreak.ts"\n@@ -1 +1 @@\n-old\n+new\n'
    + 'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n';
  const files = patchFiles(diff);
  assert.ok(files.has('gone.ts'));
  assert.ok(files.has('line\nbreak.ts'));
  assert.ok(files.has('new.ts'));
  assert.equal(files.size, 3);
});
