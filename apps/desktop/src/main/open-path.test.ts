import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { classifyOpenPath, resolveClickedPath, stripLineSuffix } from "./open-path.js";

test("clicked paths drop line suffixes, expand ~, and resolve against the project", () => {
  assert.equal(stripLineSuffix("src/app.ts:42:7"), "src/app.ts");
  assert.equal(stripLineSuffix("src/app.ts:42"), "src/app.ts");
  assert.equal(resolveClickedPath("src/app.ts:3", "/work/project"), "/work/project/src/app.ts");
  assert.equal(resolveClickedPath("./a/../b.md", "/work/project"), "/work/project/b.md");
  assert.equal(resolveClickedPath("~/notes.md", undefined, "/home/me"), "/home/me/notes.md");
  assert.equal(resolveClickedPath("/etc/hosts", undefined), "/etc/hosts");
  // A relative path without a known project cannot be resolved safely.
  assert.equal(resolveClickedPath("src/app.ts", undefined), undefined);
});

test("documents and folders open; anything that could execute is revealed instead", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-path-"));
  await writeFile(join(root, "notes.md"), "# notes");
  await writeFile(join(root, "app.ts"), "export {}");
  await writeFile(join(root, "deploy.command"), "echo hi");
  await writeFile(join(root, "tool"), "#!/bin/sh");
  await chmod(join(root, "tool"), 0o755);
  await writeFile(join(root, "script.py"), "print(1)");
  await mkdir(join(root, "folder"));
  await mkdir(join(root, "Evil.app"));

  assert.equal((await classifyOpenPath("notes.md", root))?.kind, "open");
  assert.equal((await classifyOpenPath("app.ts:10", root))?.kind, "open");
  assert.equal((await classifyOpenPath("folder", root))?.kind, "open");
  assert.equal((await classifyOpenPath("deploy.command", root))?.kind, "reveal");
  assert.equal((await classifyOpenPath("tool", root))?.kind, "reveal");
  assert.equal((await classifyOpenPath("script.py", root))?.kind, "reveal");
  assert.equal((await classifyOpenPath("Evil.app", root))?.kind, "reveal");
  assert.equal((await classifyOpenPath("missing.txt", root))?.kind, "missing");
});
