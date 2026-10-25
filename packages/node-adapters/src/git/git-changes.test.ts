import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitProjectChangesReader } from "./git-changes.js";

const execute = promisify(execFile);

test("project diff reads staged, unstaged, new and binary files without modifying the index", async () => {
  const path = await mkdtemp(join(tmpdir(), "rack-diff-"));
  const git = async (...args: string[]) => (await execute("git", ["-C", path, ...args])).stdout;
  try {
    await git("init", "-q");
    await writeFile(join(path, "tracked.txt"), "original\n");
    await git("add", "tracked.txt");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "Initial fixture");
    await writeFile(join(path, "tracked.txt"), "staged\n");
    await git("add", "tracked.txt");
    await writeFile(join(path, "tracked.txt"), "working\n");
    await writeFile(join(path, "new file.txt"), "new code\n");
    await writeFile(join(path, "binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(path, ".gitignore"), "ignored.txt\n");
    await writeFile(join(path, "ignored.txt"), "hidden\n");
    await symlink("tracked.txt", join(path, "link.txt"));
    const index = await readFile(join(path, ".git/index"));
    const snapshot = await new GitProjectChangesReader().read(path);
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.truncated, false);
    assert.match(snapshot.diff, /-original\n\+working/);
    assert.match(snapshot.diff, /\+new code/);
    assert.match(snapshot.diff, /Binary file/);
    assert.doesNotMatch(snapshot.diff, /ignored\.txt.*diff|link\.txt/);
    assert.deepEqual(await readFile(join(path, ".git/index")), index);
    const tracked = snapshot.files?.filter((file) => file.path === "tracked.txt");
    assert.deepEqual(tracked?.map((file) => file.group), ["staged", "changes"]);
    assert.match(tracked?.[0]?.diff ?? "", /-original\n\+staged/);
    assert.match(tracked?.[1]?.diff ?? "", /-staged\n\+working/);
    assert.equal(snapshot.files?.find((file) => file.path === "new file.txt")?.status, "untracked");
    assert.match(snapshot.files?.find((file) => file.path === "binary.bin")?.notice ?? "", /Binary/);
    assert.match(snapshot.files?.find((file) => file.path === "link.txt")?.notice ?? "", /Symbolic link/);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("diff handles repositories without commits, scopes subfolders, and labels non-Git folders", async () => {
  const path = await mkdtemp(join(tmpdir(), "rack-diff-empty-"));
  try {
    const reader = new GitProjectChangesReader();
    assert.equal((await reader.read(path)).status, "not_git");
    await execute("git", ["-C", path, "init", "-q"]);
    await mkdir(join(path, "project"));
    await writeFile(join(path, "outside.txt"), "outside\n");
    await writeFile(join(path, "project", "inside.txt"), "inside\n");
    const snapshot = await reader.read(join(path, "project"));
    assert.match(snapshot.diff, /inside\.txt/);
    assert.match(snapshot.diff, /\+inside/);
    assert.doesNotMatch(snapshot.diff, /outside/);
    assert.deepEqual(snapshot.files?.map((file) => file.path), ["inside.txt"]);
    await writeFile(join(path, "project", "large.txt"), "a".repeat(128_001));
    const large = await reader.read(join(path, "project"));
    assert.equal(large.truncated, true);
    assert.match(large.diff, /too large/);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("Git status retains staged changes reverted in the working tree and scopes tracked paths", async () => {
  const path = await mkdtemp(join(tmpdir(), "rack-git-status-"));
  const git = async (...args: string[]) => (await execute("git", ["-C", path, ...args])).stdout;
  try {
    await git("init", "-q");
    await mkdir(join(path, "src"));
    await writeFile(join(path, "src", "app.ts"), "original\n");
    await writeFile(join(path, "src", "old name.txt"), "rename this\n");
    await git("add", ".");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "Initial");
    await writeFile(join(path, "src", "app.ts"), "staged\n");
    await git("add", "src/app.ts");
    await writeFile(join(path, "src", "app.ts"), "original\n");
    await git("mv", "src/old name.txt", "src/new name.txt");
    await writeFile(join(path, "src", "line\nbreak.txt"), "special\n");
    const index = await readFile(join(path, ".git/index"));
    const snapshot = await new GitProjectChangesReader().read(join(path, "src"));
    const entries = snapshot.files?.filter((file) => file.path === "app.ts");
    assert.equal(entries?.length, 2);
    assert.match(entries?.[0]?.diff ?? "", /-original\n\+staged/);
    assert.match(entries?.[1]?.diff ?? "", /-staged\n\+original/);
    const renamed = snapshot.files?.find((file) => file.path === "new name.txt");
    assert.equal(renamed?.status, "renamed");
    assert.equal(renamed?.previousPath, "old name.txt");
    assert.match(renamed?.diff ?? "", /rename to new name.txt/);
    assert.ok(snapshot.files?.some((file) => file.path === "line\nbreak.txt"));
    assert.ok(snapshot.branch);
    assert.deepEqual(await readFile(join(path, ".git/index")), index);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("merge conflicts have one conflict row and a normal ours-to-working-tree patch", async () => {
  const path = await mkdtemp(join(tmpdir(), "rack-git-conflict-"));
  const git = async (...args: string[]) => (await execute("git", ["-C", path, ...args])).stdout;
  const commit = async (message: string) => {
    await git("add", ".");
    await git("-c", "commit.gpgsign=false", "commit", "-qm", message);
  };
  try {
    await git("init", "-q", "-b", "feat/base");
    // `git merge` resolves the committer identity before it attempts the
    // merge, so on a machine without one it exits with a clean tree instead
    // of conflicting, and this test would assert against nothing. Configure
    // the repository, as the other Git fixtures that merge do.
    await git("config", "user.name", "Fixture");
    await git("config", "user.email", "fixture@example.test");
    await writeFile(join(path, "conflict.txt"), "original\n"); await commit("Initial");
    await git("checkout", "-qb", "feat/other");
    await writeFile(join(path, "conflict.txt"), "theirs\n"); await commit("Other branch");
    await git("checkout", "-q", "feat/base");
    await writeFile(join(path, "conflict.txt"), "ours\n"); await commit("Base branch");
    // Require the failure to be the conflict this test is about: any other
    // Git error would otherwise satisfy the rejection and leave the
    // assertions below reporting an empty snapshot.
    await assert.rejects(git("merge", "feat/other"), (error: unknown) =>
      /^CONFLICT|\nCONFLICT/m.test(String((error as { stdout?: string }).stdout ?? "")));
    const index = await readFile(join(path, ".git/index"));
    const snapshot = await new GitProjectChangesReader().read(path);
    const rows = snapshot.files?.filter((file) => file.path === "conflict.txt");
    assert.equal(rows?.length, 1);
    assert.equal(rows?.[0]?.group, "conflicts");
    assert.equal(rows?.[0]?.status, "conflicted");
    assert.match(rows?.[0]?.diff ?? "", /^@@ /m);
    assert.match(rows?.[0]?.diff ?? "", /\+<<<<<<< HEAD/);
    assert.deepEqual(await readFile(join(path, ".git/index")), index);
  } finally { await rm(path, { recursive: true, force: true }); }
});
