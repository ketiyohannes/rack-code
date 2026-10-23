/**
 * End-to-end host behavior of shared and isolated sessions with a real Git
 * repository and the real worktree provider.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
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
import { GitWorktreeProvider } from "@rack/node-adapters/worktrees/git-worktrees";
import { GitProjectChangesReader } from "@rack/node-adapters/git/git-changes";
import type { HostEvent, ProjectChanges, SessionWorkspaceView } from "@rack/contracts";
import { HostApi } from "./host-api.js";

const execute = promisify(execFile);

/** Writes `agent.txt` in the directory the run was given. */
class WritingRuntime implements RuntimeAdapter {
  readonly runtimeId = "writing-runtime";
  readonly providerId = "fake";
  async capabilities(): Promise<RuntimeCapabilities> {
    return { resume: false, fork: false, approvals: false, quotaReporting: false, browserTools: false, computerUse: false };
  }
  describePermissionMode(mode: string): string { return mode; }
  async *startRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    await writeFile(join(input.projectPath, "agent.txt"), `written by ${input.sessionId}\n`);
    yield { type: "completed", result: "done" };
  }
  resumeRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> { return this.startRun(input); }
  async cancel(): Promise<void> {}
}

test("an isolated session edits its own worktree while the shared folder stays untouched", async () => {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "rack-host-iso-")));
  const data = await realpath(await mkdtemp(join(tmpdir(), "rack-host-iso-data-")));
  try {
    const git = (...args: string[]) => execute("git", ["-C", repo, ...args]);
    await git("init", "-q", "-b", "main");
    await writeFile(join(repo, "README.md"), "hello\n");
    await git("add", ".");
    await git("-c", "user.name=F", "-c", "user.email=f@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "Initial");

    const accounts = new AccountsService(new InMemoryAccountStore());
    const projects = new ProjectsService(new InMemoryProjectStore(), {
      changes: new GitProjectChangesReader(),
      isolation: { provider: new GitWorktreeProvider(), worktreesRoot: join(data, "worktrees") },
    });
    const sessions = new SessionsService(new InMemorySessionStore());
    const runtimes = new RuntimeRegistry();
    runtimes.register(new WritingRuntime());
    const execution = new ExecutionService(new InMemoryExecutionStore(), accounts, sessions, projects, runtimes);
    const connections = new ConnectionsService(accounts, { resolve: async (id) => ({ directory: `/contexts/${id}` }) }, []);
    const events: HostEvent[] = [];
    const api = new HostApi({ accounts, projects, sessions, sessionImports: new SessionImportsService(projects, sessions, []), execution, runtimes, connections },
      (event) => events.push(event));
    const call = async <T>(command: string, params: unknown = {}): Promise<T> => {
      const response = await api.dispatch(command, params);
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
      return response.value as T;
    };
    const project = await call<{ id: string }>("projects.create", { path: repo });
    const account = await call<{ id: string }>("accounts.register", {
      providerId: "fake", providerAccountId: "u", credential: { id: "c", providerId: "fake", method: "token" }, runtimeContextId: "ctx",
    });
    const session = await call<{ id: string }>("sessions.create", { projectId: project.id });
    // Chosen before the first message, as in the composer.
    await call("sessions.setWorkspaceMode", { sessionId: session.id, mode: "isolated" });
    assert.equal((await call<SessionWorkspaceView>("sessions.workspace", { sessionId: session.id })).exists, false);

    const started = await call<{ run: { id: string } }>("runs.start", {
      sessionId: session.id, projectId: project.id, providerId: "fake", runtimeId: "writing-runtime", accountId: account.id,
      prompt: "write", permissionMode: "full_access",
    });
    const deadline = Date.now() + 30_000;
    while (!events.some((event) => event.type === "run.finished" && event.run.id === started.run.id)) {
      if (Date.now() > deadline) throw new Error("Run did not finish.");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const finished = events.find((event) => event.type === "run.finished");
    assert.equal(finished?.type === "run.finished" && finished.run.status, "completed");

    const workspace = await call<SessionWorkspaceView>("sessions.workspace", { sessionId: session.id });
    assert.equal(workspace.mode, "isolated");
    assert.equal(workspace.exists, true);
    assert.equal(workspace.dirty, true);
    assert.match(workspace.workspace?.branch ?? "", /^rack\//);
    assert.equal(await readFile(join(workspace.path!, "agent.txt"), "utf8"), `written by ${session.id}\n`);
    await assert.rejects(stat(join(repo, "agent.txt")), "the shared folder is untouched");
    // The workspace mode is fixed after the first message.
    const locked = await api.dispatch("sessions.setWorkspaceMode", { sessionId: session.id, mode: "shared" });
    assert.equal(!locked.ok && locked.error.code, "invalid_input");

    // Changes for the session read its worktree; the project view reads the folder.
    const isolatedChanges = await call<ProjectChanges>("projects.changes", { projectId: project.id, sessionId: session.id });
    assert.ok(isolatedChanges.files?.some((file) => file.path === "agent.txt"));
    const sharedChanges = await call<ProjectChanges>("projects.changes", { projectId: project.id });
    assert.equal(sharedChanges.files?.length, 0);

    // Removal keeps the branch; uncommitted changes need force.
    const dirty = await api.dispatch("sessions.removeWorkspace", { sessionId: session.id });
    assert.equal(!dirty.ok && dirty.error.code, "workspace_dirty");
    const removed = await call<SessionWorkspaceView>("sessions.removeWorkspace", { sessionId: session.id, force: true });
    assert.equal(removed.exists, false);
    assert.match((await git("branch", "--list", "rack/*")).stdout, /rack\//);
  } finally {
    await execute("git", ["-C", repo, "worktree", "prune"]).catch(() => undefined);
    await rm(repo, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
