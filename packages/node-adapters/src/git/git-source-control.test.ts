import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitSourceControl, explain } from "./git-source-control.js";
import { GitProjectChangesReader } from "./git-changes.js";
import { GitOperationError } from "@rack/core/projects/errors";
import { ProjectsService } from "@rack/core/projects/service";
import type { ProjectRecord } from "@rack/core/projects/types";

const execute = promisify(execFile);

/** Repository with a local identity, no signing and one commit on `main`. */
async function fixture(prefix: string): Promise<{ path: string; git: (...args: string[]) => Promise<string>; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  const git = async (...args: string[]) => (await execute("git", ["-C", path, ...args])).stdout;
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.test");
  await git("config", "commit.gpgsign", "false");
  await writeFile(join(path, "tracked.txt"), "original\n");
  await git("add", "tracked.txt");
  await git("commit", "-qm", "Initial fixture");
  return { path, git, cleanup: () => rm(path, { recursive: true, force: true }) };
}

const exists = (path: string) => access(path).then(() => true, () => false);

test("stage, unstage and discard follow VS Code semantics with literal paths", async () => {
  const { path, git, cleanup } = await fixture("rack-scm-stage-");
  const scm = new GitSourceControl();
  try {
    // Names that would be globs, pathspec magic or options if not literal.
    await writeFile(join(path, "*.txt"), "star\n");
    await writeFile(join(path, "-dash.txt"), "dash\n");
    await writeFile(join(path, "tracked.txt"), "edited\n");
    await scm.run(path, undefined, { kind: "stage", paths: ["*.txt"] });
    assert.equal((await git("diff", "--cached", "--name-only")).trim(), "*.txt");
    await scm.run(path, undefined, { kind: "stage", paths: ["-dash.txt", "tracked.txt"] });
    assert.deepEqual((await git("diff", "--cached", "--name-only")).trim().split("\n").sort(), ["*.txt", "-dash.txt", "tracked.txt"]);
    await scm.run(path, undefined, { kind: "unstage", paths: ["tracked.txt"] });
    assert.deepEqual((await git("diff", "--cached", "--name-only")).trim().split("\n").sort(), ["*.txt", "-dash.txt"]);
    // Unstage keeps the working file; discard restores it from the index.
    assert.equal(await readFile(join(path, "tracked.txt"), "utf8"), "edited\n");
    await writeFile(join(path, "new.txt"), "untracked\n");
    await scm.run(path, undefined, { kind: "discard", paths: ["tracked.txt", "new.txt"] });
    assert.equal(await readFile(join(path, "tracked.txt"), "utf8"), "original\n");
    assert.equal(await exists(join(path, "new.txt")), false);
    // Staged files survive a working-tree discard.
    assert.equal(await exists(join(path, "*.txt")), true);
    await scm.run(path, undefined, { kind: "unstageAll" });
    assert.equal((await git("diff", "--cached", "--name-only")).trim(), "");
    await writeFile(join(path, ".gitignore"), "secret.env\n");
    await git("add", ".gitignore");
    await git("commit", "-qm", "Ignore secrets");
    await writeFile(join(path, "secret.env"), "keep me\n");
    await scm.run(path, undefined, { kind: "discardAll" });
    assert.equal((await git("status", "--porcelain")).trim(), "");
    // Ignored files are never deleted by discard.
    assert.equal(await exists(join(path, "secret.env")), true);
    for (const bad of ["../outside.txt", "/etc/passwd", "a/../../b"]) {
      await assert.rejects(scm.run(path, undefined, { kind: "stage", paths: [bad] }), GitOperationError);
    }
    await assert.rejects(scm.run(path, undefined, { kind: "stage", paths: [] }), /at least one file/);
  } finally { await cleanup(); }
});

test("commit validates its message, supports commit-all and amend, and refuses hidden staged files", async () => {
  const { path, git, cleanup } = await fixture("rack-scm-commit-");
  const scm = new GitSourceControl();
  try {
    await writeFile(join(path, "tracked.txt"), "changed\n");
    await assert.rejects(scm.run(path, undefined, { kind: "commit", message: "  " }), /Enter a commit message/);
    await assert.rejects(scm.run(path, undefined, { kind: "commit", message: "Nothing staged" }), /no staged changes/);
    const result = await scm.run(path, undefined, { kind: "commit", message: "Commit all\n\nBody line", all: true });
    assert.match(result.summary, /^Committed [0-9a-f]+ Commit all\.$/);
    assert.equal((await git("log", "-1", "--format=%B")).trim(), "Commit all\n\nBody line");
    await writeFile(join(path, "late.txt"), "late\n");
    await git("add", "late.txt");
    await scm.run(path, undefined, { kind: "commit", message: "", amend: true });
    assert.equal((await git("rev-list", "--count", "HEAD")).trim(), "2");
    assert.match(await git("show", "--name-only", "--format=", "HEAD"), /late\.txt/);
    // In a subfolder view, a staged file elsewhere would be committed unseen.
    await mkdir(join(path, "app"));
    await writeFile(join(path, "app", "inside.txt"), "inside\n");
    await writeFile(join(path, "outside.txt"), "outside\n");
    await git("add", "outside.txt");
    await assert.rejects(scm.run(path, "app", { kind: "commit", message: "Scoped", all: true }), /outside this folder/);
  } finally { await cleanup(); }
});

test("publish, push, pull and sync work against a remote and report tracking state", async () => {
  const remote = await mkdtemp(join(tmpdir(), "rack-scm-remote-"));
  const { path, git, cleanup } = await fixture("rack-scm-push-");
  const scm = new GitSourceControl();
  const reader = new GitProjectChangesReader();
  const other = await mkdtemp(join(tmpdir(), "rack-scm-other-"));
  try {
    await execute("git", ["init", "-q", "--bare", "-b", "main", remote]);
    await assert.rejects(scm.run(path, undefined, { kind: "push" }), /no remote/);
    await git("remote", "add", "origin", remote);
    assert.equal((await reader.read(path)).upstream, undefined);
    assert.equal((await scm.run(path, undefined, { kind: "push" })).summary, "Published main to origin.");
    assert.deepEqual(await reader.read(path).then(({ upstream, ahead, behind }) => ({ upstream, ahead, behind })), { upstream: "origin/main", ahead: 0, behind: 0 });
    await writeFile(join(path, "tracked.txt"), "local\n");
    await scm.run(path, undefined, { kind: "commit", message: "Local change", all: true });
    assert.equal((await reader.read(path)).ahead, 1);
    assert.equal((await scm.run(path, undefined, { kind: "push" })).summary, "Pushed main to origin/main.");
    // Another clone pushes; fetch shows the branch behind, pull catches up.
    await execute("git", ["clone", "-q", remote, other]);
    const otherGit = (...args: string[]) => execute("git", ["-C", other, "-c", "user.name=Other", "-c", "user.email=other@example.test", "-c", "commit.gpgsign=false", ...args]);
    await writeFile(join(other, "remote.txt"), "from remote\n");
    await otherGit("add", "remote.txt");
    await otherGit("commit", "-qm", "Remote change");
    await otherGit("push", "-q");
    await scm.run(path, undefined, { kind: "fetch" });
    assert.equal((await reader.read(path)).behind, 1);
    await writeFile(join(path, "mine.txt"), "mine\n");
    await scm.run(path, undefined, { kind: "commit", message: "Diverge", all: true });
    // Divergent branches merge (no pull.rebase configured), then push.
    const synced = await scm.run(path, undefined, { kind: "sync" });
    assert.match(synced.summary, /^Synchronized\. Pushed main/);
    const after = await reader.read(path);
    assert.deepEqual([after.ahead, after.behind], [0, 0]);
    assert.equal(await readFile(join(path, "remote.txt"), "utf8"), "from remote\n");
    assert.equal((await scm.run(path, undefined, { kind: "pull" })).summary, "Already up to date.");
  } finally {
    await cleanup();
    await rm(remote, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test("merge reports conflicts, keeps the merge in progress, and can be concluded or aborted", async () => {
  const { path, git, cleanup } = await fixture("rack-scm-merge-");
  const scm = new GitSourceControl();
  const reader = new GitProjectChangesReader();
  try {
    await scm.run(path, undefined, { kind: "createBranch", name: "feature" });
    assert.equal((await git("branch", "--show-current")).trim(), "feature");
    await assert.rejects(scm.run(path, undefined, { kind: "createBranch", name: "feature" }), /already exists/);
    for (const bad of ["-x", "bad..name", " "]) await assert.rejects(scm.run(path, undefined, { kind: "createBranch", name: bad }), /valid branch name/);
    await writeFile(join(path, "tracked.txt"), "feature\n");
    await scm.run(path, undefined, { kind: "commit", message: "Feature edit", all: true });
    await git("switch", "-q", "main");
    await writeFile(join(path, "tracked.txt"), "main\n");
    await scm.run(path, undefined, { kind: "commit", message: "Main edit", all: true });
    await assert.rejects(scm.run(path, undefined, { kind: "merge", ref: "refs/heads/missing" }), /no longer exists/);
    await assert.rejects(scm.run(path, undefined, { kind: "merge", ref: "refs/heads/main" }), /other than the current/);
    const conflicted = await scm.run(path, undefined, { kind: "merge", ref: "refs/heads/feature" });
    assert.equal(conflicted.conflicts, true);
    const during = await reader.read(path);
    assert.equal(during.merging, true);
    assert.deepEqual(during.files?.filter((file) => file.group === "conflicts").map((file) => file.path), ["tracked.txt"]);
    await assert.rejects(scm.run(path, undefined, { kind: "discard", paths: ["tracked.txt"] }), /Conflicted files/);
    await scm.run(path, undefined, { kind: "abortMerge" });
    assert.equal((await reader.read(path)).merging, undefined);
    assert.equal(await readFile(join(path, "tracked.txt"), "utf8"), "main\n");
    // Resolve and conclude with Git's prepared merge message.
    await scm.run(path, undefined, { kind: "merge", ref: "refs/heads/feature" });
    await writeFile(join(path, "tracked.txt"), "resolved\n");
    await scm.run(path, undefined, { kind: "stage", paths: ["tracked.txt"] });
    await scm.run(path, undefined, { kind: "commit", message: "" });
    assert.match((await git("log", "-1", "--format=%s")).trim(), /^Merge branch 'feature'/);
    assert.equal((await git("rev-list", "--parents", "-n", "1", "HEAD")).trim().split(" ").length, 3);
  } finally { await cleanup(); }
});

test("pull and merge are refused while a run writes in the same checkout", async () => {
  const { path, cleanup } = await fixture("rack-scm-guard-");
  const projects = new Map<string, ProjectRecord>();
  const service = new ProjectsService({
    listProjects: async () => [...projects.values()],
    getProject: async (id) => projects.get(id),
    saveProject: async (project) => { projects.set(project.id, project); },
  }, { sourceControl: new GitSourceControl() });
  try {
    const project = await service.createProject({ path });
    await service.acquireWriter(project.id, "attempt", { sessionId: "session", mode: "shared" });
    await assert.rejects(service.sourceControl(project.id, undefined, undefined, { kind: "merge", ref: "refs/heads/main" }), /Stop active runs/);
    // Index-only operations stay available during a run.
    await writeFile(join(path, "agent.txt"), "agent\n");
    await service.sourceControl(project.id, undefined, undefined, { kind: "stage", paths: ["agent.txt"] });
    await service.releaseWriter(project.id, "attempt");
    await assert.rejects(service.sourceControl(project.id, undefined, undefined, { kind: "pull" }), /no upstream/);
  } finally { await cleanup(); }
});

test("error explanations drop hints and redact URL credentials", () => {
  assert.equal(explain({ stdout: "", stderr: "fatal: unable to access 'https://user:ghp_secret@github.com/a/b.git/'\nhint: try again\n" }),
    "fatal: unable to access 'https://***@github.com/a/b.git/'");
});
