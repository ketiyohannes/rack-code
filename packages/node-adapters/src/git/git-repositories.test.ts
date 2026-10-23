import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitProjectChangesReader } from "./git-changes.js";

const execute = promisify(execFile);
async function init(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await execute("git", ["-C", path, "init", "-q"]);
}

test("discovery finds child repositories, caches scans, and rescans on request", async () => {
  const root = await mkdtemp(join(tmpdir(), "rack-repos-"));
  try {
    const reader = new GitProjectChangesReader();
    await init(join(root, "first"));
    assert.deepEqual((await reader.discover(root, {})).paths, ["first"]);
    await init(join(root, "second"));
    assert.deepEqual((await reader.discover(root, {})).paths, ["first"]);
    assert.deepEqual((await reader.discover(root, { rescan: true })).paths, ["first", "second"]);
    await writeFile(join(root, "second", "new.txt"), "second repository\n");
    assert.match((await reader.readRepository(root, "second")).diff, /second repository/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("discovery bounds depth, skips dependencies, and accepts explicit deeper folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "rack-repos-"));
  try {
    const reader = new GitProjectChangesReader();
    const deep = "a/b/c/deep";
    await init(join(root, deep));
    await init(join(root, "node_modules", "hidden"));
    const shallow = await reader.discover(root, {});
    assert.deepEqual(shallow.paths, []);
    assert.equal(shallow.limited, true);
    assert.deepEqual((await reader.discover(root, { deep: true })).paths, [deep]);
    const manual = await reader.discover(root, { repositoryPath: join(root, deep) });
    assert.equal(manual.selectedPath, deep);
    assert.deepEqual(manual.paths, [deep]);
    await assert.rejects(reader.discover(root, { repositoryPath: "a" }), /not inside a Git/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("discovery supports Git metadata files and preserves workspace subfolder scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "rack-repos-"));
  try {
    const reader = new GitProjectChangesReader();
    const repo = join(root, "repo");
    await init(repo);
    await writeFile(join(repo, "base.txt"), "base\n");
    await execute("git", ["-C", repo, "add", "."]);
    await execute("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
    await execute("git", ["-C", repo, "worktree", "add", "-qb", "fixture-branch", join(root, "linked")]);
    assert.deepEqual((await reader.discover(root, {})).paths, ["linked", "repo"]);
    const sub = join(repo, "sub");
    await mkdir(sub);
    await writeFile(join(sub, "inside.txt"), "inside\n");
    await writeFile(join(repo, "outside.txt"), "outside\n");
    assert.deepEqual((await reader.discover(sub, {})).paths, ["."]);
    const diff = await reader.readRepository(sub, ".");
    assert.match(diff.diff, /inside/);
    assert.doesNotMatch(diff.diff, /outside/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("manual selection and reads reject traversal and symlinks outside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "rack-repos-"));
  try {
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(workspace);
    await init(outside);
    await symlink(outside, join(workspace, "link"));
    const reader = new GitProjectChangesReader();
    assert.deepEqual((await reader.discover(workspace, {})).paths, []);
    for (const path of ["../outside", outside, "link"]) {
      await assert.rejects(reader.discover(workspace, { repositoryPath: path }), /inside this workspace/);
      await assert.rejects(reader.readRepository(workspace, path), /inside this workspace/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
