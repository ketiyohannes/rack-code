import assert from "node:assert/strict";
import test from "node:test";

import { buildTree } from "./timeline-tree.js";

test("changed paths group into sorted folders before files", () => {
  const tree = buildTree([
    { path: "src/b.ts", status: "modified" },
    { path: "README.md", status: "added" },
    { path: "src/lib/a.ts", status: "deleted" },
    { path: "src/a.ts", status: "added" },
  ]);
  assert.deepEqual(tree.files.map((file) => file.path), ["README.md"]);
  const src = tree.folders[0];
  assert.equal(src?.path, "src");
  assert.deepEqual(src?.files.map((file) => file.path), ["src/a.ts", "src/b.ts"]);
  assert.equal(src?.folders[0]?.path, "src/lib");
  assert.deepEqual(src?.folders[0]?.files.map((file) => file.status), ["deleted"]);
});
