import assert from "node:assert/strict";
import test from "node:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FilesService } from "@rack/features/files";
import { LocalProjectFiles } from "./local-files.js";

async function fixture(run: (root: string, files: LocalProjectFiles) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "rack-files-"));
  try { await run(root, new LocalProjectFiles()); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("files browse folders first and preserve literal names, UTF-8/BOM, line endings and executable modes", () => fixture(async (root, files) => {
  await mkdir(join(root, "folder"));
  const text = "\uFEFFhéllo\r\nworld\r\n";
  await writeFile(join(root, "a #?.txt"), text);
  await chmod(join(root, "a #?.txt"), 0o751);
  const listing = await files.list(root, "");
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["folder", "a #?.txt"]);
  const document = await files.read(root, "a #?.txt");
  assert.equal(document.text, text);
  const saved = await files.save(root, document.path, text + "more\r\n", document.version);
  assert.equal(await readFile(join(root, document.path), "utf8"), saved.text);
  assert.equal((await lstat(join(root, document.path))).mode & 0o777, 0o751);
  assert.deepEqual((await readdir(root)).sort(), ["a #?.txt", "folder"]);
}));

test("files reject traversal, absolute paths, symlink files and symlink directories", () => fixture(async (root, files) => {
  await writeFile(join(root, "real.txt"), "data");
  await mkdir(join(root, "dir"));
  await symlink(join(root, "real.txt"), join(root, "link"));
  await symlink(join(root, "dir"), join(root, "linked-dir"));
  assert.equal((await files.list(root, "")).entries.find((entry) => entry.name === "link")?.kind, "symlink");
  for (const path of ["../outside", "/etc/passwd", "link", "linked-dir", "dir/../../outside", "bad\0name"]) {
    await assert.rejects(files.read(root, path));
    await assert.rejects(files.save(root, path, "changed", "old"));
  }
  assert.equal(await readFile(join(root, "real.txt"), "utf8"), "data");
}));

test("binary, invalid UTF-8, large files and special files cannot be edited", () => fixture(async (root, files) => {
  await writeFile(join(root, "binary"), Buffer.from([0, 1, 2]));
  await writeFile(join(root, "invalid"), Buffer.from([0xff]));
  await writeFile(join(root, "large"), "x".repeat(1_048_577));
  for (const path of ["binary", "invalid", "large"]) {
    assert.equal((await files.read(root, path)).editable, false);
    await assert.rejects(files.save(root, path, "replacement", "old"));
  }
  if (process.platform !== "win32") {
    await promisify(execFile)("mkfifo", [join(root, "pipe")]);
    await assert.rejects(files.read(root, "pipe"), /regular file/);
  }
}));

test("version conflicts retain external edits and concurrent alias saves cannot both succeed", () => fixture(async (root, adapter) => {
  await writeFile(join(root, "file.txt"), "original");
  const files = new FilesService(async () => ({ path: root }), adapter);
  const first = await files.read("project", "file.txt");
  await writeFile(join(root, "file.txt"), "agent edit");
  await assert.rejects(files.save("project", "file.txt", "stale draft", first.version), { code: "file_conflict" });
  assert.equal(await readFile(join(root, "file.txt"), "utf8"), "agent edit");
  const current = await files.read("project", "file.txt");
  const results = await Promise.allSettled([
    files.save("project", "file.txt", "first", current.version),
    files.save("project", "./file.txt", "second", current.version),
  ]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected"]);
  assert.equal(await readFile(join(root, "file.txt"), "utf8"), "first");
  const empty = await files.save("project", "file.txt", "", (await files.read("project", "file.txt")).version);
  assert.equal(empty.text, "");
  assert.equal((await readFile(join(root, "file.txt"))).length, 0);
}));
