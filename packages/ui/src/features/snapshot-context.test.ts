import assert from "node:assert/strict";
import test from "node:test";
import { afterChangeLines, contextRows, sourceLines } from "./snapshot-context.js";

test("After highlights use new line numbers across replacements, insertions and deletions", () => {
  const patch = "@@ -2,2 +2,3 @@\n-old\n+replacement\n+inserted\n same\n@@ -10,2 +11 @@\n-deleted\n kept\n";
  assert.deepEqual([...afterChangeLines(patch, false)], [2, 3]);
  assert.deepEqual([...afterChangeLines("@@ -0,0 +1,2 @@\n+first\n+\n", false)], [1, 2]);
  assert.equal(afterChangeLines("@@ -1 +0,0 @@\n-deleted\n", false).size, 0);
  assert.equal(afterChangeLines("", false).size, 0);
  assert.equal(afterChangeLines(patch, true).size, 0, "partial patches cannot claim complete highlights");
});

test("full context restores unchanged lines before, between and after hunks", () => {
  const before = "top\none\ntwo\nold\nfour\nfive\nsix\nseven\neight\nlast\n";
  const after = "top\none\ntwo\nnew\nfour\nfive\nsix\nextra\nseven\neight\nlast\n";
  const rows = contextRows(before, after, "@@ -4 +4 @@\n-old\n+new\n@@ -7,2 +7,3 @@\n six\n+extra\n seven\n");
  assert.deepEqual(rows.filter((r) => r.kind !== "removed").map((r) => r.text), sourceLines(after));
  assert.deepEqual(rows.filter((r) => r.kind !== "added").map((r) => r.text), sourceLines(before));
  assert.deepEqual(rows.at(-1), { kind: "context", text: "last", oldLine: 10, newLine: 11 });
});

test("full context handles root additions, deletions, empty files and missing final newlines", () => {
  assert.deepEqual(contextRows("", "new", "@@ -0,0 +1 @@\n+new\n\\ No newline at end of file\n"), [{ kind: "added", text: "new", newLine: 1 }]);
  assert.deepEqual(contextRows("old\n", "", "@@ -1 +0,0 @@\n-old\n"), [{ kind: "removed", text: "old", oldLine: 1 }]);
  assert.deepEqual(contextRows("same\n", "same\n", ""), [{ kind: "context", text: "same", oldLine: 1, newLine: 1 }]);
  assert.deepEqual(contextRows("", "", ""), []);
  assert.deepEqual(sourceLines("\n"), [""]);
});
