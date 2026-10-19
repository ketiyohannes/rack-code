import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkspaceDirtyError } from "../../core/projects/errors.js";
import { GitWorktreeProvider } from "./git-worktrees.js";

const execute = promisify(execFile);

async function repository(): Promise<{ root: string; data: string; git: (...args: string[]) => Promise<string>; cleanup: () => Promise<void> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rack-worktree-repo-")));
  const data = await realpath(await mkdtemp(join(tmpdir(), "rack-worktree-data-")));
  const git = async (...args: string[]) => (await execute("git", ["-C", root, ...args])).stdout;
  await git("init", "-q", "-b", "main");
  await mkdir(join(root, "app"), { recursive: true });
  await writeFile(join(root, "app", "index.ts"), "export const value = 1;\n");
  await writeFile(join(root, ".gitignore"), ".env\nnode_modules/\ncache/\n");
  await git("add", ".");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "Initial");
  return { root, data, git, cleanup: async () => {
    await execute("git", ["-C", root, "worktree", "prune"]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  } };
}

test("creates a branch worktree from HEAD, keeps the subfolder scope, and leaves the main checkout alone", async () => {
  const r = await repository();
  try {
    await writeFile(join(r.root, "app", "index.ts"), "export const value = 2; // uncommitted\n");
    const index = await readFile(join(r.root, ".git", "index"));
    const provider = new GitWorktreeProvider();
    const workspace = { ...(await provider.create({ projectPath: join(r.root, "app"), worktreesRoot: r.data, sessionId: "s1" })), createdAt: "" };
    assert.match(workspace.branch, /^rack\/[0-9a-f]{8}$/);
    assert.equal(workspace.baseRef, "main");
    assert.equal(workspace.checkoutRoot, r.root);
    assert.equal(workspace.path, join(workspace.worktreePath, "app"));
    assert.ok(workspace.worktreePath.startsWith(r.data));
    // Uncommitted changes are not carried over (T3 Code / Codex CLI behavior).
    assert.equal(await readFile(join(workspace.path, "index.ts"), "utf8"), "export const value = 1;\n");
    assert.equal(await provider.exists(workspace), true);
    // The main checkout's branch, index, and files are untouched.
    assert.equal((await r.git("symbolic-ref", "--short", "HEAD")).trim(), "main");
    assert.deepEqual(await readFile(join(r.root, ".git", "index")), index);
    assert.match(await readFile(join(r.root, "app", "index.ts"), "utf8"), /uncommitted/);
    assert.deepEqual(await provider.status(workspace), { dirty: false, commitsAhead: 0 });
  } finally { await r.cleanup(); }
});

test("repository hooks do not run while creating a worktree", async () => {
  const r = await repository();
  try {
    const marker = join(r.data, "hook-ran");
    const hook = join(r.root, ".git", "hooks", "post-checkout");
    await writeFile(hook, `#!/bin/sh\ntouch "${marker}"\n`);
    await chmod(hook, 0o755);
    await new GitWorktreeProvider().create({ projectPath: r.root, worktreesRoot: join(r.data, "trees"), sessionId: "s1" });
    await assert.rejects(stat(marker));
  } finally { await r.cleanup(); }
});

test(".worktreeinclude copies matching ignored files without overwriting or following symlinks", async () => {
  const r = await repository();
  try {
    await writeFile(join(r.root, ".env"), "TOKEN=secret\n");
    await mkdir(join(r.root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(r.root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    await mkdir(join(r.root, "cache"), { recursive: true });
    await writeFile(join(r.root, "cache", "big.bin"), "not included\n");
    await symlink("/etc/hosts", join(r.root, "node_modules", "link"));
    await writeFile(join(r.root, ".worktreeinclude"), ".env\nnode_modules/\n");
    const provider = new GitWorktreeProvider();
    const workspace = await provider.create({ projectPath: r.root, worktreesRoot: r.data, sessionId: "s1" });
    assert.equal(await readFile(join(workspace.worktreePath, ".env"), "utf8"), "TOKEN=secret\n");
    assert.equal(await readFile(join(workspace.worktreePath, "node_modules", "pkg", "index.js"), "utf8"), "module.exports = 1;\n");
    await assert.rejects(stat(join(workspace.worktreePath, "cache", "big.bin")), "unlisted ignored files stay behind");
    await assert.rejects(stat(join(workspace.worktreePath, "node_modules", "link")), "symlinks are skipped");
  } finally { await r.cleanup(); }
});

test("removal keeps the branch, refuses uncommitted changes unless forced, and restore recreates the worktree", async () => {
  const r = await repository();
  try {
    const provider = new GitWorktreeProvider();
    const workspace = { ...(await provider.create({ projectPath: r.root, worktreesRoot: r.data, sessionId: "s1" })), createdAt: "" };
    const wt = async (...args: string[]) => (await execute("git", ["-C", workspace.worktreePath, ...args])).stdout;
    await writeFile(join(workspace.worktreePath, "feature.ts"), "export const feature = true;\n");
    await wt("add", "feature.ts");
    await wt("-c", "user.name=Agent", "-c", "user.email=agent@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "Feature");
    await writeFile(join(workspace.worktreePath, "draft.ts"), "draft\n");
    assert.deepEqual(await provider.status(workspace), { dirty: true, commitsAhead: 1 });
    await assert.rejects(provider.remove(workspace, { force: false }), WorkspaceDirtyError);
    await provider.remove(workspace, { force: true });
    assert.equal(await provider.exists(workspace), false);
    assert.match(await r.git("branch", "--list", workspace.branch), new RegExp(workspace.branch));
    await provider.restore(workspace);
    assert.equal(await provider.exists(workspace), true);
    assert.equal(await readFile(join(workspace.worktreePath, "feature.ts"), "utf8"), "export const feature = true;\n");
  } finally { await r.cleanup(); }
});

test("folders outside Git and repositories without commits cannot isolate", async () => {
  const plain = await mkdtemp(join(tmpdir(), "rack-worktree-plain-"));
  try {
    const provider = new GitWorktreeProvider();
    assert.match((await provider.unsupportedReason(plain)) ?? "", /need a Git repository/);
    await execute("git", ["-C", plain, "init", "-q"]);
    assert.match((await provider.unsupportedReason(plain)) ?? "", /at least one commit/);
  } finally { await rm(plain, { recursive: true, force: true }); }
});

test("parallel creations in one repository are serialized and all succeed", async () => {
  const r = await repository();
  try {
    const provider = new GitWorktreeProvider();
    const created = await Promise.all(["a", "b", "c", "d"].map((sessionId) =>
      provider.create({ projectPath: r.root, worktreesRoot: r.data, sessionId })));
    assert.equal(new Set(created.map((workspace) => workspace.branch)).size, 4);
    assert.equal(new Set(created.map((workspace) => workspace.worktreePath)).size, 4);
  } finally { await r.cleanup(); }
});
