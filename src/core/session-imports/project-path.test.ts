import assert from "node:assert/strict";
import test from "node:test";
import { sameImportProject } from "./project-path.js";

test("Windows import paths match drive casing, separators and extended paths", () => {
  assert.equal(sameImportProject("E:\\Code\\My Project", "e:/code/my project/", "win32"), true);
  assert.equal(sameImportProject("\\\\?\\E:\\Code", "e:/code", "win32"), true);
  assert.equal(sameImportProject("\\\\?\\UNC\\server\\share\\Code", "\\\\SERVER\\share\\code", "win32"), true);
  assert.equal(sameImportProject("E:\\Code", "E:\\Code\\child", "win32"), false);
  assert.equal(sameImportProject("E:\\Code", "F:\\Code", "win32"), false);
});

test("POSIX import paths preserve case and exact-folder boundaries", () => {
  assert.equal(sameImportProject("/projects/code", "/projects/Code", "linux"), false);
  assert.equal(sameImportProject("/projects/code", "/projects/code/child", "linux"), false);
});
