/**
 * Host integration of the optional Timeline feature: assembly, command
 * dispatch, run capture through `ActiveRuns`, and failure isolation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { InMemoryAccountStore } from "@rack/core/accounts/in-memory-store";
import { AccountsService } from "@rack/core/accounts/service";
import { InMemoryExecutionStore } from "@rack/core/execution/in-memory-store";
import { RuntimeRegistry } from "@rack/core/execution/runtime-registry";
import { ExecutionService } from "@rack/core/execution/service";
import type { RuntimeAdapter, RuntimeCapabilities, RuntimeEvent, RuntimeRunInput } from "@rack/core/execution/types";
import { InMemoryProjectStore } from "@rack/core/projects/in-memory-store";
import { ProjectsService } from "@rack/core/projects/service";
import { InMemorySessionStore } from "@rack/core/sessions/in-memory-store";
import { SessionsService } from "@rack/core/sessions/service";
import { SessionImportsService } from "@rack/core/session-imports/service";
import { ConnectionsService } from "@rack/core/connections/service";
import type { HostEvent, TimelineCheckpointList, TimelineProjectHistory, TimelineStatus, TimelineSnapshot, TimelineSnapshotFileView } from "@rack/contracts";
import { TimelineService, type SnapshotRepository } from "@rack/features/timeline";
import { GitSnapshotRepository } from "@rack/node-adapters/timeline/git-snapshots";
import { JsonTimelineStore } from "@rack/node-adapters/storage/json-timeline-store";
import { HostApi } from "./host-api.js";

const execute = promisify(execFile);

/** Edits a file inside a tool call, like an agent would. */
class EditingRuntime implements RuntimeAdapter {
  readonly runtimeId = "editing-runtime";
  readonly providerId = "fake";
  release: (() => void) | undefined;
  /** When set, the run waits for `release()` before finishing. */
  hold = false;

  async capabilities(): Promise<RuntimeCapabilities> {
    return { resume: false, fork: false, approvals: false, quotaReporting: false, browserTools: false, computerUse: false };
  }

  describePermissionMode(mode: string): string { return mode; }

  async *startRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    yield { type: "tool_request", tool: "Edit", input: { path: "agent.ts" }, toolCallId: "call-1" };
    await writeFile(join(input.projectPath, "agent.ts"), "export const agent = true;\n");
    yield { type: "tool_result", output: "ok", toolCallId: "call-1" };
    if (this.hold) await new Promise<void>((resolve) => { this.release = resolve; });
    yield { type: "completed", result: "done" };
  }

  resumeRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> { return this.startRun(input); }
  async cancel(): Promise<void> {}
}

async function setup(options: { timeline?: boolean; snapshots?: SnapshotRepository } = {}) {
  const path = await mkdtemp(join(tmpdir(), "rack-host-timeline-"));
  const data = await mkdtemp(join(tmpdir(), "rack-host-timeline-data-"));
  await execute("git", ["-C", path, "init", "-q"]);
  await writeFile(join(path, "README.md"), "hello\n");
  const accounts = new AccountsService(new InMemoryAccountStore());
  const projects = new ProjectsService(new InMemoryProjectStore());
  const sessions = new SessionsService(new InMemorySessionStore());
  const runtimes = new RuntimeRegistry();
  const runtime = new EditingRuntime();
  runtimes.register(runtime);
  const execution = new ExecutionService(new InMemoryExecutionStore(), accounts, sessions, projects, runtimes);
  const connections = new ConnectionsService(accounts, { resolve: async (id) => ({ directory: `/contexts/${id}` }) }, []);
  const sessionImports = new SessionImportsService(projects, sessions, []);
  const timeline = options.timeline === false ? undefined : new TimelineService(
    {
      projects: async () => (await projects.listProjects()).map((project) => ({ projectId: project.id, projectPath: project.path })),
      project: async (projectId) => ({ projectPath: (await projects.getProject(projectId)).path }),
      session: async (sessionId) => {
        const session = await sessions.get(sessionId);
        const project = await projects.getProject(session.projectId!);
        return { sessionId, projectId: project.id, projectPath: project.path };
      },
      projectBusy: async (projectId, sessionId) => projects.activeWriters(projectId).some((writer) => sessionId === undefined || writer.sessionId === sessionId),
    },
    new JsonTimelineStore(join(data, "timeline.json")),
    options.snapshots ?? new GitSnapshotRepository(),
  );
  const events: HostEvent[] = [];
  const api = new HostApi({
    accounts, projects, sessions, sessionImports, execution, runtimes, connections,
    ...(timeline === undefined ? {} : { timeline }),
  }, (event) => events.push(event));
  const call = async <T>(command: string, params: unknown = {}): Promise<T> => {
    const response = await api.dispatch(command, params);
    if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.value as T;
  };
  const project = await call<{ id: string }>("projects.create", { path });
  const session = await call<{ id: string }>("sessions.create", { projectId: project.id });
  const account = await call<{ id: string }>("accounts.register", {
    providerId: "fake", providerAccountId: "user-1",
    credential: { id: "cred-1", providerId: "fake", method: "token" }, runtimeContextId: "ctx-1",
  });
  const startRun = () => call<{ run: { id: string } }>("runs.start", {
    sessionId: session.id, projectId: project.id, providerId: "fake", runtimeId: "editing-runtime", accountId: account.id,
    prompt: "edit", permissionMode: "full_access",
  });
  const cleanup = async () => {
    await rm(path, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  };
  return { api, call, events, runtime, path, project, session, startRun, cleanup };
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("timeline commands report feature_unavailable when the feature is not assembled", async () => {
  const f = await setup({ timeline: false });
  try {
    const response = await f.api.dispatch("timeline.status", { sessionId: f.session.id });
    assert.equal(!response.ok && response.error.code, "feature_unavailable");
    const projectHistory = await f.api.dispatch("timeline.projectHistory", { projectId: f.project.id });
    assert.equal(!projectHistory.ok && projectHistory.error.code, "feature_unavailable");
    // Runs are unaffected by the missing feature (T02-style independence).
    await f.startRun();
    await waitFor(() => f.events.some((event) => event.type === "run.finished"));
  } finally { await f.cleanup(); }
});

test("project history commands read existing Git commits without session opt-in", async () => {
  const f = await setup();
  try {
    await execute("git", ["-C", f.path, "add", "README.md"]);
    await execute("git", ["-C", f.path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "Preexisting commit"]);
    const history = await f.call<TimelineProjectHistory>("timeline.projectHistory", { projectId: f.project.id });
    assert.equal(history.checkpoints[0]?.source, "git");
    assert.equal(history.checkpoints[0]?.label, "Preexisting commit");
    const diff = await f.call<{ diff: string }>("timeline.projectFileDiff", { projectId: f.project.id, checkpointId: history.checkpoints[0]!.id, path: "README.md" });
    assert.match(diff.diff, /^\+hello$/m);
    assert.equal((await f.call<TimelineStatus>("timeline.status", { sessionId: f.session.id })).enabled, false);
    const invalid = await f.api.dispatch("timeline.projectHistory", { sessionId: f.session.id });
    assert.equal(!invalid.ok && invalid.error.code, "invalid_input");
    const unknown = await f.api.dispatch("timeline.projectHistory", { projectId: "unknown-project" });
    assert.equal(!unknown.ok && unknown.error.code, "project_not_found");
  } finally { await f.cleanup(); }
});

test("snapshot commands return a historical tree and exact file contents through the host", async () => {
  const f = await setup();
  try {
    await execute("git", ["-C", f.path, "add", "README.md"]);
    await execute("git", ["-C", f.path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "Existing root"]);
    const history = await f.call<TimelineProjectHistory>("timeline.projectHistory", { projectId: f.project.id });
    const target = { scope: "project", contextId: f.project.id, checkpointId: history.checkpoints[0]!.id };
    const snapshot = await f.call<TimelineSnapshot>("timeline.snapshot", target);
    assert.deepEqual(snapshot.files, [{ path: "README.md", before: false, after: true, status: "added" }]);
    await writeFile(join(f.path, "README.md"), "live contents\n");
    const file = await f.call<TimelineSnapshotFileView>("timeline.snapshotFile", { ...target, path: "README.md" });
    assert.equal(file.after?.text, "hello\n");
    const invalid = await f.api.dispatch("timeline.snapshot", { ...target, scope: "revision" });
    assert.equal(!invalid.ok && invalid.error.code, "invalid_input");
    const outside = await f.api.dispatch("timeline.snapshotFile", { ...target, path: "../outside" });
    assert.equal(!outside.ok && outside.error.code, "snapshot_path_invalid");
  } finally { await f.cleanup(); }
});

test("an opted-in session records the run's file changes through the host", async () => {
  const f = await setup();
  try {
    assert.equal((await f.call<TimelineStatus>("timeline.status", { sessionId: f.session.id })).enabled, false);
    await f.call("timeline.setEnabled", { sessionId: f.session.id, enabled: true });
    const { run } = await f.startRun();
    await waitFor(() => f.events.some((event) => event.type === "run.finished"));
    // "Run settled" is captured after run.finished; wait for its signal.
    await waitFor(async () => (await f.call<TimelineCheckpointList>("timeline.checkpoints", { sessionId: f.session.id })).checkpoints.length > 0);
    const list = await f.call<TimelineCheckpointList>("timeline.checkpoints", { sessionId: f.session.id });
    const entry = list.checkpoints[0];
    assert.deepEqual(entry?.files, [{ path: "agent.ts", status: "added" }]);
    assert.equal(entry?.runId, run.id);
    assert.ok(f.events.some((event) => event.type === "timeline.changed" && event.sessionId === f.session.id));
    const diff = await f.call<{ diff: string }>("timeline.fileDiff", { sessionId: f.session.id, checkpointId: entry!.id, path: "agent.ts" });
    assert.match(diff.diff, /^\+export const agent = true;$/m);
    const missing = await f.api.dispatch("timeline.fileDiff", { sessionId: f.session.id, checkpointId: "checkpoint:none", path: "agent.ts" });
    assert.equal(!missing.ok && missing.error.code, "snapshot_not_found");
  } finally { await f.cleanup(); }
});

test("enablement cannot change while a run edits the project", async () => {
  const f = await setup();
  try {
    f.runtime.hold = true;
    await f.startRun();
    await waitFor(() => f.runtime.release !== undefined);
    const response = await f.api.dispatch("timeline.setEnabled", { sessionId: f.session.id, enabled: true });
    assert.equal(!response.ok && response.error.code, "timeline_busy");
    f.runtime.release?.();
    await waitFor(() => f.events.some((event) => event.type === "run.finished"));
  } finally { await f.cleanup(); }
});

test("a failing capture never prevents the run from completing (T14)", async () => {
  const real = new GitSnapshotRepository();
  const failing: SnapshotRepository = {
    tree: (path, snapshot) => real.tree(path, snapshot),
    content: (path, snapshot, file) => real.content(path, snapshot, file),
    projectHistory: (path, limit) => real.projectHistory(path, limit),
    probe: (path) => real.probe(path),
    capture: async () => { throw new Error("cannot write objects"); },
    existingRefs: (path, refs) => real.existingRefs(path, refs),
    history: (path, refs, limit) => real.history(path, refs, limit),
    changedPaths: (path, previous, snapshot) => real.changedPaths(path, previous, snapshot),
    visiblePaths: (path, paths) => real.visiblePaths(path, paths),
    patch: (path, previous, snapshot, file) => real.patch(path, previous, snapshot, file),
  };
  const f = await setup({ snapshots: failing });
  try {
    await f.call("timeline.setEnabled", { sessionId: f.session.id, enabled: true });
    await f.startRun();
    await waitFor(() => f.events.some((event) => event.type === "run.finished"));
    const finished = f.events.find((event) => event.type === "run.finished");
    assert.equal(finished?.type === "run.finished" && finished.run.status, "completed");
    const status = await f.call<TimelineStatus>("timeline.status", { sessionId: f.session.id });
    assert.equal(status.captureError, "cannot write objects");
    assert.equal(status.enabled, true, "a capture failure does not clear the persisted preference");
  } finally { await f.cleanup(); }
});
