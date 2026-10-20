/** Real Git checkout tests: every mutation stays inside disposable repositories. */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitProjectBranches } from "./git-branches.js";
import { InMemoryProjectStore } from "../../core/projects/in-memory-store.js";
import { ProjectsService } from "../../core/projects/service.js";

const execute = promisify(execFile);
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "rack-branches-"));
  const git = async (...args: string[]) => (await execute("git", ["-C", path, ...args])).stdout.trim();
  await git("init", "-b", "main"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.test");
  await writeFile(join(path, "file.txt"), "main\n"); await git("add", "."); await git("commit", "-m", "Initial");
  await git("switch", "-c", "feature"); await writeFile(join(path, "file.txt"), "feature\n"); await git("commit", "-am", "Feature"); await git("switch", "main");
  return { path, git, adapter: new GitProjectBranches(), cleanup: () => rm(path, { recursive: true, force: true }) };
}

test("branch checkout switches files and HEAD, refuses dirty/stale/invalid requests and preserves the index", async () => {
  const f = await fixture();
  try {
    const catalog = await f.adapter.list(f.path);
    assert.equal(catalog.current, "main");
    await f.adapter.checkout(f.path, "refs/heads/feature", catalog.head!);
    assert.equal(await readFile(join(f.path, "file.txt"), "utf8"), "feature\n");
    await assert.rejects(f.adapter.checkout(f.path, "refs/heads/main", catalog.head!), /changed since/);
    const current = await f.adapter.list(f.path);
    await writeFile(join(f.path, "file.txt"), "my edits\n"); await f.git("add", "file.txt");
    const index = await readFile(join(f.path, ".git/index"));
    await assert.rejects(f.adapter.checkout(f.path, "refs/heads/main", current.head!), /Commit or stash/);
    assert.deepEqual(await readFile(join(f.path, ".git/index")), index);
    assert.equal(await readFile(join(f.path, "file.txt"), "utf8"), "my edits\n");
    await assert.rejects(f.adapter.checkout(f.path, "--discard-changes", current.head!), /no longer exists/);
    assert.equal(await f.git("branch", "--show-current"), "feature");
  } finally { await f.cleanup(); }
});

test("remote checkout creates tracking branches and branches in another worktree are protected", async () => {
  const f = await fixture();
  const linked = `${f.path}-linked`;
  try {
    const head = await f.git("rev-parse", "HEAD");
    await f.git("config", "remote.origin.url", f.path); await f.git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    await f.git("update-ref", "refs/remotes/origin/topic", head);
    const switched = await f.adapter.checkout(f.path, "refs/remotes/origin/topic", head);
    assert.equal(switched.current, "topic");
    assert.equal(await f.git("rev-parse", "--abbrev-ref", "@{upstream}"), "origin/topic");
    await f.git("worktree", "add", linked, "feature");
    await assert.rejects(f.adapter.checkout(f.path, "refs/heads/feature", head), /another worktree/);
    assert.equal(await f.git("branch", "--show-current"), "topic");
  } finally { await rm(linked, { recursive: true, force: true }); await f.cleanup(); }
});

test("checkout blocks alias writers and prevents new run ownership while Git is switching", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.path, "nested"));
    const projects = new ProjectsService(new InMemoryProjectStore(), { branches: f.adapter });
    const project = await projects.createProject({ path: f.path });
    const alias = await projects.createProject({ path: join(f.path, "nested") });
    const head = (await f.adapter.list(f.path)).head!;
    await projects.acquireWriter(alias.id, "attempt", { sessionId: "session", mode: "shared" });
    await assert.rejects(projects.checkoutBranch(project.id, "refs/heads/feature", head), /Stop active runs/);
    await projects.releaseWriter(alias.id, "attempt");
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const guarded = new ProjectsService(new InMemoryProjectStore(), { branches: {
      repositoryId: p => f.adapter.repositoryId(p), list: p => f.adapter.list(p),
      checkout: async (...args) => { entered(); await gate; return f.adapter.checkout(...args); },
    } });
    const owned = await guarded.createProject({ path: f.path });
    const switching = guarded.checkoutBranch(owned.id, "refs/heads/feature", head);
    await started;
    await assert.rejects(guarded.acquireWriter(owned.id, "new-attempt", { sessionId: "new-session", mode: "shared" }), /checkout is in progress/);
    release(); await switching;
    await guarded.acquireWriter(owned.id, "new-attempt", { sessionId: "new-session", mode: "shared" });
    assert.equal(guarded.activeWriters(owned.id).length, 1);
  } finally { await f.cleanup(); }
});
