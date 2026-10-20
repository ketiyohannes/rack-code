/**
 * Timeline service tests against real Git repositories in temporary folders.
 * IDs in comments (T01...) refer to the acceptance criteria in
 * docs/timeline.md and the product specification.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GitSnapshotRepository } from "../../adapters/timeline/git-snapshots.js";
import { JsonTimelineStore } from "../../adapters/storage/json-timeline-store.js";
import { SnapshotNotFoundError, SnapshotPathError, TimelineBusyError, TimelineUnsupportedError } from "./errors.js";
import type { ProjectWatcher, SnapshotRepository, TimelineCoreAccess } from "./ports.js";
import { RunRecorder } from "./recorder.js";
import { TimelineService, refFor } from "./service.js";

const execute = promisify(execFile);

interface Fixture {
  readonly path: string;
  readonly dataDirectory: string;
  readonly git: (...args: string[]) => Promise<string>;
  readonly core: TimelineCoreAccess & { busy: boolean; codexId?: string };
  service(options?: { snapshots?: SnapshotRepository; watcher?: ProjectWatcher }): TimelineService;
  cleanup(): Promise<void>;
}

const SESSION = "5b0b1f9e-1111-4c1c-9a39-1d5e0c7c0001";
const OTHER_SESSION = "5b0b1f9e-1111-4c1c-9a39-1d5e0c7c0002";

test("automatic project tracking records existing dirty projects without sessions or import", async () => {
  const f = await fixture();
  const service = f.service();
  try {
    await writeFile(join(f.path, "README.md"), "edited before tracking started\n");
    const head = await f.git("rev-parse", "HEAD");
    const index = await readFile(join(f.path, ".git/index"));
    await service.startProjectTracking();
    const changes = (await service.projectHistory("project-1")).checkpoints.filter((entry) => entry.source !== "git");
    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0]?.files, [{ path: "README.md", status: "modified" }]);
    assert.match((await service.projectFileDiff("project-1", changes[0]!.id, "README.md")).diff, /edited before tracking started/);
    assert.equal((await service.status(SESSION)).enabled, false);
    assert.equal(await f.git("rev-parse", "HEAD"), head);
    assert.deepEqual(await readFile(join(f.path, ".git/index")), index);
  } finally { await service.stopProjectTracking(); await f.cleanup(); }
});

test("container projects discover their single repository for history, live recording and exact versions", async () => {
  const f = await fixture({ container: true });
  let changed: (() => void) | undefined;
  let watched: string | undefined;
  const service = f.service({ watcher: { watch: (root, notify) => {
    watched = root; changed = notify;
    return { close() { changed = undefined; } };
  } } });
  try {
    const parent = (await f.core.project("project-1")).projectPath;
    await writeFile(join(parent, "outside.txt"), "outside the repository\n");
    const head = await f.git("rev-parse", "HEAD");
    const index = await readFile(join(f.path, ".git/index"));
    assert.equal((await service.projectHistory("project-1")).checkpoints[0]?.label, "Initial");
    await writeFile(join(f.path, "README.md"), "edited before observation\n");
    await service.startProjectTracking();
    assert.equal(watched, await realpath(f.path), "watch the discovered repository, not its container");
    let recorded = (await service.projectHistory("project-1")).checkpoints.filter((entry) => entry.source !== "git");
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0]?.files, [{ path: "README.md", status: "modified" }]);
    await writeFile(join(f.path, "README.md"), "edited during development\n");
    changed!();
    await waitFor(async () => (await service.projectHistory("project-1")).checkpoints.filter((entry) => entry.source !== "git").length === 2, 10_000);
    recorded = (await service.projectHistory("project-1")).checkpoints.filter((entry) => entry.source !== "git");
    const target = { scope: "project" as const, contextId: "project-1", checkpointId: recorded.at(-1)!.id };
    const contents = await service.snapshotFile(target, "README.md");
    assert.equal(contents.before?.text, "edited before observation\n");
    assert.equal(contents.after?.text, "edited during development\n");
    assert.deepEqual((await service.snapshot(target)).files.map((file) => file.path), ["README.md"]);
    await service.setEnabled(SESSION, true);
    await recordRun(service, async () => writeFile(join(f.path, "session.ts"), "session capture\n"));
    assert.ok((await service.checkpoints(SESSION)).checkpoints.some((entry) => entry.files.some((file) => file.path === "session.ts")));
    assert.equal(await f.git("rev-parse", "HEAD"), head);
    assert.deepEqual(await readFile(join(f.path, ".git/index")), index);
  } finally { await service.stopProjectTracking(); await f.cleanup(); }
});

test("container discovery refuses ambiguous repositories and external repository symlinks", async () => {
  const f = await fixture({ container: true });
  const linked = await mkdtemp(join(tmpdir(), "rack-timeline-linked-"));
  const service = f.service();
  try {
    const parent = (await f.core.project("project-1")).projectPath;
    await mkdir(join(parent, "another"));
    await execute("git", ["-C", join(parent, "another"), "init", "-q"]);
    const status = await service.projectHistory("project-1");
    assert.equal(status.supported, false);
    assert.match(status.reason!, /multiple Git repositories/);
    await service.startProjectTracking();
    assert.equal((await f.git("for-each-ref", "--format=%(refname)", "refs/rack-project-timeline/")).trim(), "");
    await symlink(f.path, join(linked, "external"));
    assert.equal((await new GitSnapshotRepository().probe(linked)).supported, false);
  } finally { await service.stopProjectTracking(); await rm(linked, { recursive: true, force: true }); await f.cleanup(); }
});

test("automatic tracking observes edits in repositories with no HEAD and falls back when watching ends", async () => {
  const f = await fixture({ commit: false });
  let changed: (() => void) | undefined;
  let closed = false;
  const service = f.service({ watcher: { watch: (_root, callback) => {
    changed = callback;
    return { get closed() { return closed; }, close() { closed = true; } };
  } } });
  try {
    await service.startProjectTracking();
    assert.ok(changed);
    await writeFile(join(f.path, "observed.ts"), "first\n");
    changed!();
    await waitFor(async () => (await service.projectHistory("project-1")).checkpoints.some((entry) => entry.files.some((file) => file.path === "observed.ts")), 10_000);
    // An unexpectedly closed native watcher switches to periodic capture.
    closed = true;
    await writeFile(join(f.path, "fallback.ts"), "fallback\n");
    await service.refreshProjects();
    assert.ok((await service.projectHistory("project-1")).checkpoints.some((entry) => entry.files.some((file) => file.path === "fallback.ts")));
    await assert.rejects(f.git("rev-parse", "--verify", "HEAD"));
  } finally { await service.stopProjectTracking(); await f.cleanup(); }
});

test("project pause persists and resume records current changes without deleting history", async () => {
  const f = await fixture();
  let service = f.service();
  try {
    await service.setProjectEnabled("project-1", false);
    await service.startProjectTracking();
    await writeFile(join(f.path, "paused.ts"), "paused\n");
    await service.refreshProjects();
    assert.equal((await service.projectHistory("project-1")).recording, false);
    assert.equal((await service.projectHistory("project-1")).checkpoints.filter((entry) => entry.source !== "git").length, 0);
    await service.stopProjectTracking();
    service = f.service();
    await service.startProjectTracking();
    assert.equal((await service.projectHistory("project-1")).recording, false);
    const resumed = await service.setProjectEnabled("project-1", true);
    assert.equal(resumed.recording, true);
    assert.ok(resumed.checkpoints.some((entry) => entry.files.some((file) => file.path === "paused.ts")));
  } finally { await service.stopProjectTracking(); await f.cleanup(); }
});

test("newly registered projects acquire a tracker without requiring a session", async () => {
  const f = await fixture();
  let registered = false;
  f.core.projects = async () => registered ? [{ projectId: "project-1", projectPath: f.path }] : [];
  let watches = 0;
  const service = f.service({ watcher: { watch: () => { watches++; return { close() {} }; } } });
  try {
    await service.startProjectTracking();
    assert.equal(watches, 0);
    registered = true;
    await writeFile(join(f.path, "new-project.ts"), "new\n");
    await service.refreshProjects();
    assert.equal(watches, 1);
    assert.ok((await service.projectHistory("project-1")).checkpoints.some((entry) => entry.files.some((file) => file.path === "new-project.ts")));
    registered = false;
    await service.refreshProjects();
  } finally { await service.stopProjectTracking(); await f.cleanup(); }
});

test("expanded history navigation spans project commits and other sessions", async () => {
  const f = await fixture();
  try {
    const service = f.service();
    await service.setEnabled(SESSION, true);
    await recordRun(service, async () => writeFile(join(f.path, "one.ts"), "one\n"));
    await service.setEnabled(OTHER_SESSION, true);
    await recordRun(service, async () => writeFile(join(f.path, "two.ts"), "two\n"), OTHER_SESSION);
    const initial = (await service.checkpoints(SESSION)).checkpoints[0]!;
    const history = await service.snapshotHistory({ scope: "session", contextId: SESSION, checkpointId: initial.id });
    assert.ok(history.entries.some((entry) => entry.source === "git"));
    assert.equal(history.entries.filter((entry) => entry.source !== "git").length, 2);
    for (const entry of history.entries) assert.equal((await service.snapshot(entry.target)).id, entry.id);
    await assert.rejects(service.snapshotHistory({ scope: "project", contextId: "project-1", checkpointId: "HEAD" }), SnapshotNotFoundError);
  } finally { await f.cleanup(); }
});

test("snapshot viewer includes unchanged and deleted files and reads exact historical contents", async () => {
  const f = await fixture();
  try {
    const service = f.service();
    await writeFile(join(f.path, "deleted.txt"), "old content\n");
    await f.git("add", ".");
    await f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "Before");
    await service.setEnabled(SESSION, true);
    await recordRun(service, async () => {
      await rm(join(f.path, "deleted.txt"));
      await writeFile(join(f.path, "new.ts"), "export const first = true;\n\n");
    });
    const id = (await service.checkpoints(SESSION)).checkpoints[0]!.id;
    const target = { scope: "session" as const, contextId: SESSION, checkpointId: id };
    const view = await service.snapshot(target);
    assert.deepEqual(view.files, [
      { path: "deleted.txt", before: true, after: false, status: "deleted" },
      { path: "new.ts", before: false, after: true, status: "added" },
      { path: "README.md", before: true, after: true },
    ]);
    // Move the working file on after capture: the window must stay historical.
    await writeFile(join(f.path, "new.ts"), "live working file\n");
    assert.equal((await service.snapshotFile(target, "new.ts")).after?.text, "export const first = true;\n\n");
    const deleted = await service.snapshotFile(target, "deleted.txt");
    assert.equal(deleted.before?.text, "old content\n");
    assert.equal(deleted.after, undefined);
    const unchanged = await service.snapshotFile(target, "README.md");
    assert.equal(unchanged.before?.text, "hello\n");
    assert.equal(unchanged.after?.text, "hello\n");
    assert.equal(unchanged.diff, "");
    await assert.rejects(service.snapshotFile(target, "../outside"), SnapshotPathError);
    await service.setEnabled(SESSION, false);
    await assert.rejects(service.snapshot(target), SnapshotNotFoundError);
  } finally { await f.cleanup(); }
});

test("project snapshots support root commits and literal special filenames without checkout", async () => {
  const f = await fixture();
  try {
    const service = f.service();
    const root = (await service.projectHistory("project-1")).checkpoints[0]!;
    const target = { scope: "project" as const, contextId: "project-1", checkpointId: root.id };
    const rootFile = await service.snapshotFile(target, "README.md");
    assert.equal(rootFile.before, undefined);
    assert.equal(rootFile.after?.text, "hello\n");
    await writeFile(join(f.path, ":odd[1]\nname.ts"), "literal\n");
    await f.git("add", ".");
    await f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "Special path");
    const latest = (await service.projectHistory("project-1")).checkpoints.at(-1)!;
    const current = { ...target, checkpointId: latest.id };
    const head = await f.git("rev-parse", "HEAD");
    const index = await readFile(join(f.path, ".git/index"));
    assert.equal((await service.snapshotFile(current, ":odd[1]\nname.ts")).after?.text, "literal\n");
    assert.equal(await f.git("rev-parse", "HEAD"), head);
    assert.deepEqual(await readFile(join(f.path, ".git/index")), index);
    assert.equal((await service.status(SESSION)).enabled, false);
    await assert.rejects(service.snapshot({ ...target, checkpointId: "HEAD" }), SnapshotNotFoundError);
  } finally { await f.cleanup(); }
});

test("snapshot contents label binary, oversized, symlink and empty files safely", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.path, "binary.dat"), Buffer.from([0, 1, 2]));
    await writeFile(join(f.path, "large.txt"), "a".repeat(1024 * 1024 + 1));
    await writeFile(join(f.path, "empty.txt"), "");
    await symlink("/etc/passwd", join(f.path, "link"));
    await f.git("add", ".");
    await f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "Content kinds");
    const repo = new GitSnapshotRepository();
    const hash = (await f.git("rev-parse", "HEAD")).trim();
    assert.match((await repo.content(f.path, hash, "binary.dat")).notice!, /Binary/);
    assert.equal((await repo.content(f.path, hash, "large.txt")).truncated, true);
    assert.deepEqual(await repo.content(f.path, hash, "empty.txt"), { text: "", truncated: false });
    assert.deepEqual(await repo.content(f.path, hash, "link"), { text: "", truncated: false, notice: "Symbolic link; content preview unavailable." });
  } finally { await f.cleanup(); }
});

test("All files obeys current visibility rules for unchanged paths and rejects other snapshots", async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    const service = f.service();
    const id = (await service.projectHistory("project-1")).checkpoints[0]!.id;
    const target = { scope: "project" as const, contextId: "project-1", checkpointId: id };
    await writeFile(join(f.path, ".gitignore"), "README.md\n");
    assert.deepEqual((await service.snapshot(target)).files, []);
    await assert.rejects(service.snapshotFile(target, "README.md"), SnapshotPathError);
    await writeFile(join(other.path, "foreign"), "other\n");
    await other.git("add", ".");
    await other.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "Other");
    await assert.rejects(service.snapshot({ ...target, checkpointId: `checkpoint:${(await other.git("rev-parse", "HEAD")).trim()}` }), SnapshotNotFoundError);
  } finally { await f.cleanup(); await other.cleanup(); }
});

test("existing Git history is readable without enabling or importing a session", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.path, "README.md"), "second version\n");
    await f.git("add", "README.md");
    await f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "Existing change");
    const head = await f.git("rev-parse", "HEAD");
    const branch = await f.git("symbolic-ref", "HEAD");
    const index = await readFile(join(f.path, ".git/index"));
    const service = f.service();
    const history = await service.projectHistory("project-1");
    assert.equal(history.supported, true);
    assert.equal(history.truncated, false);
    assert.deepEqual(history.checkpoints.map((entry) => [entry.label, entry.source]), [["Initial", "git"], ["Existing change", "git"]]);
    const first = history.checkpoints[0]!;
    assert.deepEqual(first.files, [{ path: "README.md", status: "added" }]);
    assert.match((await service.projectFileDiff("project-1", first.id, "README.md")).diff, /^\+hello$/m);
    assert.match((await service.projectFileDiff("project-1", history.checkpoints[1]!.id, "README.md")).diff, /^\+second version$/m);
    assert.equal((await service.status(SESSION)).enabled, false);
    assert.deepEqual((await service.checkpoints(SESSION)).checkpoints, []);
    assert.deepEqual(await new JsonTimelineStore(join(f.dataDirectory, "timeline.json")).get(SESSION), undefined);
    assert.equal(await f.git("rev-parse", "HEAD"), head);
    assert.equal(await f.git("symbolic-ref", "HEAD"), branch);
    assert.deepEqual(await readFile(join(f.path, ".git/index")), index);
    assert.equal(await readFile(join(f.path, "README.md"), "utf8"), "second version\n");
  } finally { await f.cleanup(); }
});

test("project history discovers other sessions and Codex or Relay refs without a session index", async () => {
  const f = await fixture();
  try {
    const service = f.service();
    await service.setEnabled(OTHER_SESSION, true);
    await recordRun(service, async () => writeFile(join(f.path, "other.ts"), "other session\n"), OTHER_SESSION);
    const snapshots = new GitSnapshotRepository();
    for (const namespace of ["codex", "relay"]) {
      const ref = `refs/${namespace}-timeline/native-session`;
      await snapshots.capture({ projectPath: f.path, ref, label: "Baseline", trailers: {} });
      await writeFile(join(f.path, `${namespace}.ts`), `${namespace}\n`);
      await snapshots.capture({ projectPath: f.path, ref, label: `After ${namespace}`, trailers: {} });
    }
    // No app checkpoint index or opt-in is needed to discover existing refs.
    await rm(join(f.dataDirectory, "timeline.json"));
    const fresh = f.service();
    const history = await fresh.projectHistory("project-1");
    assert.ok(history.checkpoints.some((entry) => entry.source === "git"));
    const other = history.checkpoints.find((entry) => entry.sessionId === OTHER_SESSION)!;
    assert.deepEqual(other.files, [{ path: "other.ts", status: "added" }]);
    assert.match((await fresh.projectFileDiff("project-1", other.id, "other.ts")).diff, /^\+other session$/m);
    for (const namespace of ["codex", "relay"]) assert.ok(history.checkpoints.some((entry) => entry.label === `After ${namespace}` && entry.source === "imported"));
    assert.equal(new Set(history.checkpoints.map((entry) => entry.snapshot)).size, history.checkpoints.length);
    assert.equal((await fresh.status(SESSION)).enabled, false);
    assert.deepEqual((await fresh.checkpoints(SESSION)).checkpoints, []);
  } finally { await f.cleanup(); }
});

test("project previews reject arbitrary revisions, unrelated commits, and invisible paths", async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    await writeFile(join(other.path, "foreign.ts"), "foreign\n");
    await other.git("add", "foreign.ts");
    await other.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "Foreign");
    const service = f.service();
    const entry = (await service.projectHistory("project-1")).checkpoints[0]!;
    await assert.rejects(service.projectFileDiff("project-1", "HEAD", "README.md"), SnapshotNotFoundError);
    await assert.rejects(service.projectFileDiff("project-1", `checkpoint:${(await other.git("rev-parse", "HEAD")).trim()}`, "foreign.ts"), SnapshotNotFoundError);
    await assert.rejects(service.projectFileDiff("project-1", entry.id, "../README.md"), SnapshotPathError);
    // Current ignore rules are re-read even when immutable comparisons are cached.
    await writeFile(join(f.path, ".gitignore"), "README.md\n");
    assert.deepEqual((await service.projectHistory("project-1")).checkpoints, []);
    await assert.rejects(service.projectFileDiff("project-1", entry.id, "README.md"), SnapshotPathError);
  } finally { await f.cleanup(); await other.cleanup(); }
});

test("project history refreshes external commits and bounds repository reads", async () => {
  const f = await fixture();
  try {
    const service = f.service();
    assert.equal((await service.projectHistory("project-1")).checkpoints.length, 1);
    for (const label of ["Second", "Third"]) {
      await writeFile(join(f.path, "README.md"), `${label}\n`);
      await f.git("add", "README.md");
      await f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", label);
    }
    assert.equal((await service.projectHistory("project-1")).checkpoints.length, 3);
    const bounded = await new GitSnapshotRepository().projectHistory(f.path, 2);
    assert.equal(bounded.truncated, true);
    assert.deepEqual(bounded.records.map((entry) => entry.label), ["Second", "Third"]);
  } finally { await f.cleanup(); }
});

test("an unborn repository supports project history and later saved session snapshots", async () => {
  const f = await fixture({ commit: false });
  try {
    const service = f.service();
    assert.deepEqual(await service.projectHistory("project-1"), { projectId: "project-1", supported: true, truncated: false, recording: true, checkpoints: [] });
    await service.setEnabled(OTHER_SESSION, true);
    await recordRun(service, async () => writeFile(join(f.path, "new.ts"), "new\n"), OTHER_SESSION);
    const history = await service.projectHistory("project-1");
    assert.deepEqual(history.checkpoints.map((entry) => entry.files), [[{ path: "new.ts", status: "added" }]]);
    await assert.rejects(f.git("rev-parse", "--verify", "HEAD"));
  } finally { await f.cleanup(); }
});

async function fixture(options: { commit?: boolean; container?: boolean } = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "rack-timeline-"));
  const path = options.container ? join(directory, "rack-code") : directory;
  if (options.container) await mkdir(path);
  const projectPath = options.container ? directory : path;
  const dataDirectory = await mkdtemp(join(tmpdir(), "rack-timeline-data-"));
  const git = async (...args: string[]) => (await execute("git", ["-C", path, ...args])).stdout;
  await git("init", "-q");
  await writeFile(join(path, "README.md"), "hello\n");
  if (options.commit !== false) {
    await git("add", "README.md");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "Initial");
  }
  const core: Fixture["core"] = {
    busy: false,
    projects: async () => [{ projectId: "project-1", projectPath }],
    project: async () => ({ projectPath }),
    async session(sessionId) {
      return {
        sessionId, projectId: "project-1", projectPath,
        ...(core.codexId === undefined ? {} : { importedCodexSessionId: core.codexId }),
      };
    },
    async projectBusy() { return core.busy; },
  };
  const store = new JsonTimelineStore(join(dataDirectory, "timeline.json"));
  return {
    path, dataDirectory, git, core,
    service: (overrides = {}) => new TimelineService(core, store, overrides.snapshots ?? new GitSnapshotRepository(), {
      ...(overrides.watcher === undefined ? {} : { watcher: overrides.watcher }),
      debounceMs: 5,
    }),
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
      await rm(dataDirectory, { recursive: true, force: true });
    },
  };
}

/** Runs a complete observed run that writes `edit` between baseline and settle. */
async function recordRun(service: TimelineService, edit: () => Promise<void>, sessionId = SESSION): Promise<void> {
  const observer = await service.beginRun({ sessionId });
  assert.ok(observer, "expected an observer for an enabled session");
  observer.bindRun("run-1");
  await edit();
  await observer.finish();
}

test("new sessions start disabled and enabling persists across service instances (T01, T03)", async () => {
  const f = await fixture();
  try {
    const status = await f.service().status(SESSION);
    assert.equal(status.supported, true);
    assert.equal(status.enabled, false);
    assert.equal((await f.service().setEnabled(SESSION, true)).enabled, true);
    // A fresh service over a fresh store instance reads the persisted flag.
    const reopened = new TimelineService(f.core, new JsonTimelineStore(join(f.dataDirectory, "timeline.json")), new GitSnapshotRepository());
    assert.equal((await reopened.status(SESSION)).enabled, true);
  } finally { await f.cleanup(); }
});

test("disabled sessions record nothing and do not advance the ref (T07)", async () => {
  const f = await fixture();
  try {
    const service = f.service();
    assert.equal(await service.beginRun({ sessionId: SESSION }), undefined);
    await assert.rejects(f.git("rev-parse", "--verify", refFor(SESSION)));
  } finally { await f.cleanup(); }
});

test("capture preserves HEAD and the user's index with staged and unstaged edits (T08)", async () => {
  const f = await fixture();
  try {
    const service = f.service();
    await service.setEnabled(SESSION, true);
    await writeFile(join(f.path, "README.md"), "staged\n");
    await f.git("add", "README.md");
    await writeFile(join(f.path, "README.md"), "unstaged\n");
    const head = await f.git("rev-parse", "HEAD");
    const branch = await f.git("symbolic-ref", "HEAD");
    const index = await readFile(join(f.path, ".git/index"));
    await recordRun(service, async () => writeFile(join(f.path, "new.ts"), "export const a = 1;\n"));
    assert.equal(await f.git("rev-parse", "HEAD"), head);
    assert.equal(await f.git("symbolic-ref", "HEAD"), branch);
    assert.deepEqual(await readFile(join(f.path, ".git/index")), index);
    assert.equal(await readFile(join(f.path, "README.md"), "utf8"), "unstaged\n");
    const list = await service.checkpoints(SESSION);
    assert.deepEqual(list.checkpoints.map((entry) => entry.label), ["Run settled"]);
    assert.deepEqual(list.checkpoints[0]?.files, [{ path: "new.ts", status: "added" }]);
  } finally { await f.cleanup(); }
});

test("an identical tree creates no additional checkpoint (T09)", async () => {
  const f = await fixture();
  try {
    const service = f.service();
    await service.setEnabled(SESSION, true);
    await recordRun(service, async () => writeFile(join(f.path, "a.txt"), "a\n"));
    const tip = await f.git("rev-parse", refFor(SESSION));
    await recordRun(service, async () => undefined);
    assert.equal(await f.git("rev-parse", refFor(SESSION)), tip);
    assert.equal((await service.checkpoints(SESSION)).checkpoints.length, 1);
  } finally { await f.cleanup(); }
});

test("a created then deleted file stays inspectable (T10)", async () => {
  const f = await fixture();
  try {
    const service = f.service();
    await service.setEnabled(SESSION, true);
    const observer = await service.beginRun({ sessionId: SESSION });
    assert.ok(observer);
    observer.observe({ type: "tool_request", tool: "Write", toolCallId: "call-1" });
    await writeFile(join(f.path, "temporary.ts"), "export const temporary = true;\n");
    observer.observe({ type: "tool_result", toolCallId: "call-1" });
    observer.observe({ type: "tool_request", tool: "Bash", toolCallId: "call-2" });
    // Wait until the queued captures above have observed the file.
    await waitFor(async () => (await service.checkpoints(SESSION)).checkpoints.length >= 1);
    await rm(join(f.path, "temporary.ts"));
    observer.observe({ type: "tool_result", toolCallId: "call-2" });
    await observer.finish();
    const { checkpoints } = await service.checkpoints(SESSION);
    const created = checkpoints.find((entry) => entry.files.some((file) => file.path === "temporary.ts" && file.status === "added"));
    const deleted = checkpoints.find((entry) => entry.files.some((file) => file.path === "temporary.ts" && file.status === "deleted"));
    // Which boundary observed each state depends on asynchronous timing;
    // the product promise is only that both states were captured.
    assert.ok(created && deleted, "expected creation and deletion checkpoints");
    const diff = await service.fileDiff(SESSION, deleted.id, "temporary.ts");
    assert.match(diff.diff, /^-export const temporary = true;$/m);
    assert.equal(diff.status, "deleted");
  } finally { await f.cleanup(); }
});

test("tool boundaries are labelled and associated with tool call IDs", async () => {
  const f = await fixture();
  try {
    // Count captures so the test can wait for "Before tool" deterministically;
    // in production that capture may legitimately observe the edit already.
    const real = new GitSnapshotRepository();
    let captures = 0;
    const counting: SnapshotRepository = Object.assign(Object.create(real) as GitSnapshotRepository, {
      capture: async (input: Parameters<SnapshotRepository["capture"]>[0]) => {
        try { return await real.capture(input); } finally { captures++; }
      },
    });
    const service = f.service({ snapshots: counting });
    await service.setEnabled(SESSION, true);
    const observer = await service.beginRun({ sessionId: SESSION });
    assert.ok(observer);
    observer.bindRun("run-9");
    const before = captures;
    observer.observe({ type: "tool_request", tool: "Edit", toolCallId: "call-7" });
    await waitFor(async () => captures > before);
    await writeFile(join(f.path, "README.md"), "edited\n");
    observer.observe({ type: "tool_result", toolCallId: "call-7" });
    await observer.finish();
    const entry = (await service.checkpoints(SESSION)).checkpoints[0];
    assert.equal(entry?.label, "After Edit");
    assert.equal(entry?.toolCallId, "call-7");
    assert.equal(entry?.runId, "run-9");
  } finally { await f.cleanup(); }
});

test("display filtering hides excluded and ignored paths using current rules", async () => {
  const f = await fixture();
  try {
    const service = f.service();
    await service.setEnabled(SESSION, true);
    await writeFile(join(f.path, ".gitignore"), "secret.env\n");
    await recordRun(service, async () => {
      await mkdir(join(f.path, ".github"), { recursive: true });
      await writeFile(join(f.path, ".github", "workflow.yml"), "on: push\n");
      await writeFile(join(f.path, "secret.env"), "TOKEN=1\n");
      await writeFile(join(f.path, "visible.ts"), "1\n");
    });
    const files = (await service.checkpoints(SESSION)).checkpoints.flatMap((entry) => entry.files.map((file) => file.path));
    assert.ok(files.includes("visible.ts"));
    assert.ok(!files.includes(".github/workflow.yml"));
    assert.ok(!files.includes("secret.env"));
    await assert.rejects(service.fileDiff(SESSION, (await service.checkpoints(SESSION)).checkpoints[0]!.id, ".github/workflow.yml"), SnapshotPathError);
  } finally { await f.cleanup(); }
});

test("import reads exact identities only, skips baselines, and never duplicates (T03, T04, T05)", async () => {
  const f = await fixture();
  try {
    // Record history, then lose the index (as if timeline.json were removed).
    const recorder = f.service();
    await recorder.setEnabled(SESSION, true);
    await recordRun(recorder, async () => writeFile(join(f.path, "one.ts"), "1\n"));
    await recordRun(recorder, async () => writeFile(join(f.path, "two.ts"), "2\n"));
    // A similarly prefixed ref must not enter this session.
    await f.git("update-ref", `${refFor(SESSION)}-copy`, refFor(SESSION));
    await rm(join(f.dataDirectory, "timeline.json"));
    const fresh = new TimelineService(f.core, new JsonTimelineStore(join(f.dataDirectory, "timeline.json")), new GitSnapshotRepository());
    await fresh.setEnabled(SESSION, true);
    const first = (await fresh.checkpoints(SESSION)).checkpoints;
    assert.deepEqual(first.map((entry) => entry.files.map((file) => file.path)), [["one.ts"], ["two.ts"]]);
    assert.ok(first.every((entry) => entry.source === "imported"));
    // Re-enabling imports nothing new.
    await fresh.setEnabled(SESSION, false);
    await fresh.setEnabled(SESSION, true);
    assert.equal((await fresh.checkpoints(SESSION)).checkpoints.length, 2);
    // Another session sees nothing from this session's ref (T05, T06).
    await fresh.setEnabled(OTHER_SESSION, true);
    assert.equal((await fresh.checkpoints(OTHER_SESSION)).checkpoints.length, 0);
    assert.equal((await fresh.status(SESSION)).enabled, true);
  } finally { await f.cleanup(); }
});

test("imported Codex sessions read their exact codex-timeline ref and skip external baselines", async () => {
  const f = await fixture();
  try {
    const codexId = "019a0000-aaaa-7bbb-8ccc-000000000001";
    f.core.codexId = codexId;
    const env = { ...process.env, GIT_AUTHOR_NAME: "Codex", GIT_AUTHOR_EMAIL: "c@example.test", GIT_COMMITTER_NAME: "Codex", GIT_COMMITTER_EMAIL: "c@example.test" };
    const commitTree = async (tree: string, message: string, parent?: string) => (await execute("git",
      ["-C", f.path, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], { env })).stdout.trim();
    const baseTree = (await f.git("rev-parse", "HEAD^{tree}")).trim();
    const baseline = await commitTree(baseTree, "codex-timeline: Session baseline");
    await writeFile(join(f.path, "codex.ts"), "1\n");
    await f.git("add", "codex.ts");
    const tree = (await f.git("write-tree")).trim();
    await f.git("reset", "-q");
    const change = await commitTree(tree, "codex-timeline: apply_patch", baseline);
    await f.git("update-ref", `refs/codex-timeline/${codexId}`, change);
    const service = f.service();
    await service.setEnabled(SESSION, true);
    const { checkpoints } = await service.checkpoints(SESSION);
    assert.deepEqual(checkpoints.map((entry) => entry.label), ["apply_patch"]);
  } finally { await f.cleanup(); }
});

test("enablement is independent per session and blocked while a run edits the project (T06)", async () => {
  const f = await fixture();
  try {
    const service = f.service();
    await service.setEnabled(SESSION, true);
    assert.equal((await service.status(OTHER_SESSION)).enabled, false);
    f.core.busy = true;
    await assert.rejects(service.setEnabled(SESSION, false), TimelineBusyError);
    f.core.busy = false;
    assert.equal((await service.status(SESSION)).enabled, true);
  } finally { await f.cleanup(); }
});

test("repositories without HEAD are supported (T13)", async () => {
  const f = await fixture({ commit: false });
  try {
    const service = f.service();
    await service.setEnabled(SESSION, true);
    await recordRun(service, async () => writeFile(join(f.path, "first.ts"), "1\n"));
    assert.deepEqual((await service.checkpoints(SESSION)).checkpoints.map((entry) => entry.files[0]?.path), ["first.ts"]);
  } finally { await f.cleanup(); }
});

test("non-Git folders are unsupported and cannot be enabled", async () => {
  const path = await mkdtemp(join(tmpdir(), "rack-timeline-plain-"));
  const data = await mkdtemp(join(tmpdir(), "rack-timeline-data-"));
  try {
    const core: TimelineCoreAccess = {
      projects: async () => [{ projectId: "p", projectPath: path }],
      project: async () => ({ projectPath: path }),
      session: async (sessionId) => ({ sessionId, projectId: "p", projectPath: path }),
      projectBusy: async () => false,
    };
    const service = new TimelineService(core, new JsonTimelineStore(join(data, "timeline.json")), new GitSnapshotRepository());
    const status = await service.status(SESSION);
    assert.equal(status.supported, false);
    assert.equal(status.reason, "Timeline is not supported for this project.");
    await assert.rejects(service.setEnabled(SESSION, true), TimelineUnsupportedError);
    assert.equal(await service.beginRun({ sessionId: SESSION }), undefined);
  } finally {
    await rm(path, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

test("capture failure never rejects and is reported until a later capture succeeds (T14)", async () => {
  const f = await fixture();
  try {
    const real = new GitSnapshotRepository();
    let fail = true;
    const flaky: SnapshotRepository = {
      tree: (path, snapshot) => real.tree(path, snapshot),
      content: (path, snapshot, file) => real.content(path, snapshot, file),
      projectHistory: (path, limit) => real.projectHistory(path, limit),
      probe: (path) => real.probe(path),
      capture: async (input) => {
        if (fail) throw new Error("disk full");
        return real.capture(input);
      },
      existingRefs: (path, refs) => real.existingRefs(path, refs),
      history: (path, refs, limit) => real.history(path, refs, limit),
      changedPaths: (path, previous, snapshot) => real.changedPaths(path, previous, snapshot),
      visiblePaths: (path, paths) => real.visiblePaths(path, paths),
      patch: (path, previous, snapshot, file) => real.patch(path, previous, snapshot, file),
    };
    const service = f.service({ snapshots: flaky });
    await service.setEnabled(SESSION, true);
    assert.equal(await service.beginRun({ sessionId: SESSION }), undefined);
    assert.equal((await service.status(SESSION)).captureError, "disk full");
    fail = false;
    await recordRun(service, async () => writeFile(join(f.path, "later.ts"), "1\n"));
    assert.equal((await service.status(SESSION)).captureError, undefined);
  } finally { await f.cleanup(); }
});

test("unknown checkpoints and paths fail with the specified messages", async () => {
  const f = await fixture();
  try {
    const service = f.service();
    await service.setEnabled(SESSION, true);
    await recordRun(service, async () => writeFile(join(f.path, "x.ts"), "1\n"));
    await assert.rejects(service.fileDiff(SESSION, "checkpoint:unknown", "x.ts"), (error: Error) =>
      error instanceof SnapshotNotFoundError && error.message === "No snapshot for this action");
    const id = (await service.checkpoints(SESSION)).checkpoints[0]!.id;
    await assert.rejects(service.fileDiff(SESSION, id, "README.md"), (error: Error) =>
      error instanceof SnapshotPathError && error.message === "File is not part of this snapshot");
  } finally { await f.cleanup(); }
});

test("filesystem observations are debounced and coalesced", async () => {
  const captures: string[] = [];
  let release: (() => void) | undefined;
  let notify: (() => void) | undefined;
  const recorder = new RunRecorder({
    capture: async (label) => {
      captures.push(label);
      // Hold the first capture so later activity has to queue behind it.
      if (captures.length === 1) await new Promise<void>((resolve) => { release = resolve; });
    },
    onFailure: () => undefined,
    startWatch: (onChange) => { notify = onChange; return { close: () => { notify = undefined; } }; },
    debounceMs: 5,
  });
  notify?.();
  await delay(20);
  // Many events while the first observation is running yield one more capture.
  for (let index = 0; index < 10; index++) { notify?.(); await delay(10); }
  await delay(20);
  release?.();
  await recorder.finish();
  assert.deepEqual(captures, ["Live filesystem observation", "Live filesystem observation", "Run settled"]);
  assert.equal(notify, undefined, "finish closes the watcher");
});

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await delay(20);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("all-branch history includes unmerged and remote commits, merge parents and empty commits with working snapshot navigation", async () => {
  const f = await fixture();
  try {
    await f.git("config", "user.name", "Fixture"); await f.git("config", "user.email", "fixture@example.test");
    const base = (await f.git("branch", "--show-current")).trim();
    await f.git("switch", "-c", "topic");
    await writeFile(join(f.path, "topic.txt"), "topic work\n"); await f.git("add", "."); await f.git("commit", "-m", "Topic change");
    const topic = (await f.git("rev-parse", "HEAD")).trim();
    await f.git("switch", base); await f.git("merge", "--no-ff", "topic", "-m", "Merge topic");
    await f.git("branch", "-d", "topic"); // Its second-parent history must remain visible.
    await f.git("switch", "-c", "unmerged"); await f.git("commit", "--allow-empty", "-m", "Empty branch marker");
    await writeFile(join(f.path, "unmerged.txt"), "not merged\n"); await f.git("add", "."); await f.git("commit", "-m", "Unmerged change");
    await f.git("update-ref", "refs/remotes/origin/remote-topic", "HEAD");
    await f.git("switch", base);
    const service = f.service();
    const current = await service.projectHistory("project-1");
    assert.ok(!current.checkpoints.some(e => e.snapshot === topic || e.label === "Unmerged change"));
    const history = await service.projectHistory("project-1", "all");
    assert.equal(new Set(history.checkpoints.map(e => e.snapshot)).size, history.checkpoints.length);
    const merged = history.checkpoints.find(e => e.label === "Merge topic")!;
    assert.equal(merged.parents?.length, 2);
    assert.ok(merged.parents?.includes(topic));
    assert.ok(history.checkpoints.some(e => e.snapshot === topic));
    assert.ok(history.checkpoints.some(e => e.label === "Empty branch marker" && e.files.length === 0));
    const unmerged = history.checkpoints.find(e => e.label === "Unmerged change")!;
    assert.ok(unmerged.branches?.includes("unmerged")); assert.ok(unmerged.branches?.includes("origin/remote-topic"));
    const target = { scope: "project" as const, contextId: "project-1", checkpointId: unmerged.id };
    assert.ok((await service.snapshot(target)).files.some(file => file.path === "unmerged.txt"));
    assert.match((await service.projectFileDiff("project-1", unmerged.id, "unmerged.txt")).diff, /not merged/);
    assert.ok((await service.snapshotHistory(target)).entries.some(e => e.id === unmerged.id));
    assert.equal((await f.git("branch", "--show-current")).trim(), base, "Reading history never checks out files");
  } finally { await f.cleanup(); }
});

test("all-branch history supports a repository with no commits", async () => {
  const f = await fixture({ commit: false });
  try { assert.deepEqual((await f.service().projectHistory("project-1", "all")).checkpoints, []); }
  finally { await f.cleanup(); }
});
