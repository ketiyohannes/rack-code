import assert from "node:assert/strict";
import test from "node:test";
import { moveRow, orderedIds } from "./sidebar-order.js";

test("saved sidebar order survives refresh while dropping stale IDs and appending new rows", () => {
  assert.deepEqual(orderedIds(["a", "b", "new"], ["b", "removed", "b", "a"]), ["b", "a", "new"]);
  assert.deepEqual(orderedIds(["b", "a"], ["a", "b"]), ["a", "b"]);
});

test("sibling moves work in both directions and reject missing rows", () => {
  assert.deepEqual(moveRow(["a", "b", "c"], "a", "c", true), ["b", "c", "a"]);
  assert.deepEqual(moveRow(["a", "b", "c"], "c", "a", false), ["c", "a", "b"]);
  assert.deepEqual(moveRow(["a", "b"], "other-folder", "a", false), ["a", "b"]);
  assert.deepEqual(moveRow(["a", "b"], "a", "a", true), ["a", "b"]);
});
