/** Integration of the imported concurrency feature with the current composition:
 * real worktrees/files/Timeline, deterministic runtime and terminal boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "./composition/application.js";
import type { RuntimeAdapter, RuntimeCapabilities, RuntimeEvent, RuntimeRunInput } from "@rack/core/execution/types";
import type { FileDocument } from "@rack/features/files";
import { TerminalService } from "@rack/features/terminal";
import type { HostCommandMap, HostEvent, SessionWorkspaceView, TimelineCheckpointList } from "@rack/contracts";
import { HostApi } from "./host-api.js";

class ConcurrentRuntime implements RuntimeAdapter {
  readonly runtimeId = "concurrent-test";
  readonly providerId = "fixture";
  readonly inputs = new Map<string, RuntimeRunInput>();
  readonly releases = new Map<string, () => void>();
  async capabilities(): Promise<RuntimeCapabilities> { return { resume: false, fork: false, approvals: false, quotaReporting: false, browserTools: false, computerUse: false }; }
  describePermissionMode(mode: string) { return mode; }
  async *startRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    this.inputs.set(input.sessionId, input);
    yield { type: "tool_request", tool: "write", toolCallId: input.sessionId, input: {} };
    await writeFile(join(input.projectPath, "agent.txt"), input.sessionId);
    yield { type: "tool_result", toolCallId: input.sessionId, output: "written" };
    await new Promise<void>((resolve) => { this.releases.set(input.sessionId, resolve); });
    yield { type: "completed", result: input.sessionId };
  }
  resumeRun(input: RuntimeRunInput) { return this.startRun(input); }
  async cancel() { for (const release of this.releases.values()) release(); }
}

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Concurrent fixture timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

// The full suite runs many real Git fixtures concurrently; allow their disk
// contention while retaining bounded per-stage waits below.
test("isolated sessions keep Files, Terminal, Timeline and durable history in their own worktrees", { timeout: 120_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rack-concurrent-tools-")));
  const repo = join(root, "repo"), data = join(root, "data");
  const execute = promisify(execFile);
  const git = (...args: string[]) => execute("git", ["-C", repo, ...args]);
  await execute("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "README.md"), "base\n");
  await git("add", ".");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "Initial");
  const app = createApplication({ dataDirectory: data });
  const runtime = new ConcurrentRuntime(); app.runtimes.register(runtime);
  const terminalPaths: string[] = [];
  const terminal = new TerminalService({ label: "Fixture shell", start: async input => {
    terminalPaths.push(input.cwd);
    return { write: async () => {}, resize: async () => {}, close: async () => {} };
  } });
  const events: HostEvent[] = [];
  const host = new HostApi({ ...app, terminal }, event => events.push(event));
  const call = async <K extends keyof HostCommandMap>(command: K, params: HostCommandMap[K]["params"]): Promise<HostCommandMap[K]["result"]> => {
    const reply = await host.dispatch(command, params);
    assert.ok(reply.ok, reply.ok ? "" : `${reply.error.code}: ${reply.error.message}`);
    return reply.value as HostCommandMap[K]["result"];
  };
  try {
    const project = await call("projects.create", { path: repo });
    await call("timeline.setProjectEnabled", { projectId: project.id, enabled: false });
    const account = await call("accounts.register", { providerId: "fixture", providerAccountId: "test", credential: { id: "fixture", providerId: "fixture", method: "test" }, runtimeContextId: "fixture" });
    const a = await call("sessions.create", { projectId: project.id, workspaceMode: "isolated" });
    const b = await call("sessions.create", { projectId: project.id, workspaceMode: "isolated" });
    assert.equal((await call("sessions.list", {})).find(s => s.id === a.id)?.workspaceMode, "isolated");
    // Read-only tool requests cannot accidentally open the main checkout before creation.
    for (const command of ["sessions.directory", "sessions.files.list"] as const) {
      const reply = await host.dispatch(command, { sessionId: a.id, ...(command === "sessions.files.list" ? { path: "" } : {}) });
      assert.equal(!reply.ok && reply.error.code, "isolation_unavailable");
    }
    await call("timeline.setEnabled", { sessionId: a.id, enabled: true });
    await call("timeline.setEnabled", { sessionId: b.id, enabled: true });
    const start = (sessionId: string) => call("runs.start", { sessionId, projectId: project.id, accountId: account.id, runtimeId: runtime.runtimeId, providerId: "fixture", prompt: "write", permissionMode: "full_access" });
    const [first, second] = await Promise.all([start(a.id), start(b.id)]);
    await until(() => runtime.releases.size === 2);
    assert.equal((await call("runs.active", {})).length, 2);
    assert.equal((await call("projects.list", {}))[0]?.activeWriters.length, 2);
    const duplicate = await host.dispatch("runs.start", { sessionId: a.id, projectId: project.id, accountId: account.id, runtimeId: runtime.runtimeId, providerId: "fixture", prompt: "again", permissionMode: "full_access" });
    assert.equal(!duplicate.ok && duplicate.error.code, "session_busy");
    const busyRemoval = await host.dispatch("sessions.removeWorkspace", { sessionId: a.id, force: true });
    assert.equal(!busyRemoval.ok && busyRemoval.error.code, "session_busy");
    const [wa, wb] = await Promise.all([call("sessions.workspace", { sessionId: a.id }), call("sessions.workspace", { sessionId: b.id })]);
    assert.notEqual(wa.path, wb.path);
    assert.equal(await call("sessions.directory", { sessionId: a.id }), wa.path);
    assert.equal(runtime.inputs.get(a.id)?.projectPath, wa.path);
    assert.equal(runtime.inputs.get(a.id)?.checkoutRoot, repo);
    assert.equal(await readFile(join(wa.path!, "agent.txt"), "utf8"), a.id);
    assert.equal(await readFile(join(wb.path!, "agent.txt"), "utf8"), b.id);
    await assert.rejects(readFile(join(repo, "agent.txt")));
    const document: FileDocument = await call("sessions.files.read", { sessionId: a.id, path: "README.md" });
    await call("sessions.files.save", { sessionId: a.id, path: "README.md", text: "edited in worktree\n", version: document.version });
    assert.equal(await readFile(join(repo, "README.md"), "utf8"), "base\n");
    await Promise.all([call("terminal.open", { sessionId: a.id, projectId: project.id, cols: 80, rows: 24 }), call("terminal.open", { sessionId: b.id, projectId: project.id, cols: 80, rows: 24 })]);
    assert.deepEqual(new Set(terminalPaths), new Set([wa.path, wb.path]));
    // Another session's run does not block this session's Timeline preferences.
    const idle = await call("sessions.create", { projectId: project.id, workspaceMode: "isolated" });
    await call("timeline.setEnabled", { sessionId: idle.id, enabled: true });
    for (const release of runtime.releases.values()) release();
    await until(() => [first.run.id, second.run.id].every(id => events.some(event => event.type === "run.finished" && event.run.id === id)));
    for (const session of [a, b]) {
      await until(async () => (await call("timeline.checkpoints", { sessionId: session.id })).checkpoints.some(entry => entry.files.some(file => file.path === "agent.txt")));
      const history: TimelineCheckpointList = await call("timeline.checkpoints", { sessionId: session.id });
      const checkpoint = history.checkpoints.find(entry => entry.files.some(file => file.path === "agent.txt"))!;
      const patch = await call("timeline.fileDiff", { sessionId: session.id, checkpointId: checkpoint.id, path: "agent.txt" });
      assert.ok(patch.diff.includes(session.id));
      assert.ok(!patch.diff.includes(session.id === a.id ? b.id : a.id));
    }
    const dirty = await host.dispatch("sessions.removeWorkspace", { sessionId: a.id });
    assert.equal(!dirty.ok && dirty.error.code, "workspace_dirty");
    await call("sessions.removeWorkspace", { sessionId: a.id, force: true });
    const missing = await host.dispatch("sessions.directory", { sessionId: a.id });
    assert.equal(!missing.ok && missing.error.code, "isolation_unavailable");
    // Restore keeps the same branch/path and does not write a new legacy JSON history.
    const restored = await app.projects.prepareExecutionDirectory(project.id, a.id, "isolated");
    assert.equal(restored.path, wa.path); assert.equal(restored.workspace?.branch, wa.workspace?.branch);
    const reopened = createApplication({ dataDirectory: data, timeline: false });
    assert.equal((await reopened.sessions.get(a.id)).workspaceMode, "isolated");
    assert.equal((await reopened.execution.listRuns(a.id))[0]?.status, "completed");
    assert.ok((await reopened.execution.listJournal(first.run.id)).length > 0);
    const standalone = await call("sessions.create", {});
    const invalid = await host.dispatch("sessions.setWorkspaceMode", { sessionId: standalone.id, mode: "isolated" });
    assert.equal(!invalid.ok && invalid.error.code, "isolation_unavailable");
    await call("sessions.remove", { sessionId: b.id });
    assert.equal(await readFile(join(wb.path!, "agent.txt"), "utf8"), b.id, "deletion retains worktree contents");
  } finally {
    for (const release of runtime.releases.values()) release();
    await host.shutdown(8000);
    await rm(root, { recursive: true, force: true });
  }
});
