import assert from "node:assert/strict";
import test from "node:test";

import { IsolationUnavailableError, SessionBusyError } from "./errors.js";
import { InMemoryProjectStore } from "./in-memory-store.js";
import type { IsolatedWorkspaceProvider } from "./ports.js";
import { ProjectsService } from "./service.js";
import type { IsolatedWorkspace } from "./types.js";

test("adding the same folder again reuses its project and live writers", async () => {
  const projects = new ProjectsService(new InMemoryProjectStore());
  const first = await projects.createProject({ path: "/tmp/demo" });
  await projects.acquireWriter(first.id, "active-attempt", { sessionId: "s1", mode: "shared" });
  const repeated = await projects.createProject({ path: "/tmp/demo/../demo/" });
  assert.equal(repeated.id, first.id);
  assert.deepEqual(projects.activeWriters(first.id).map((writer) => writer.attemptId), ["active-attempt"]);
  assert.equal((await projects.listProjects()).length, 1);
});

test("concurrent requests to add one folder create only one project", async () => {
  const projects = new ProjectsService(new InMemoryProjectStore());
  const added = await Promise.all([
    projects.createProject({ path: "/tmp/demo" }),
    projects.createProject({ path: "/tmp/demo/" }),
  ]);
  assert.equal(added[0]?.id, added[1]?.id);
  assert.equal((await projects.listProjects()).length, 1);
});

test("different sessions may write concurrently; one session runs one attempt at a time", async () => {
  const projects = new ProjectsService(new InMemoryProjectStore());
  const project = await projects.createProject({ path: "/tmp/demo" });
  await projects.acquireWriter(project.id, "a1", { sessionId: "shared-1", mode: "shared" });
  await projects.acquireWriter(project.id, "a2", { sessionId: "shared-2", mode: "shared" });
  await projects.acquireWriter(project.id, "a3", { sessionId: "isolated-1", mode: "isolated" });
  // Re-acquiring the same attempt is idempotent.
  await projects.acquireWriter(project.id, "a1", { sessionId: "shared-1", mode: "shared" });
  await assert.rejects(projects.acquireWriter(project.id, "a4", { sessionId: "shared-1", mode: "shared" }), SessionBusyError);
  assert.deepEqual(projects.activeWriters(project.id).map((writer) => writer.attemptId), ["a1", "a2", "a3"]);
  await projects.releaseWriter(project.id, "a1");
  await projects.acquireWriter(project.id, "a4", { sessionId: "shared-1", mode: "shared" });
  assert.deepEqual(projects.activeWriters(project.id).map((writer) => writer.sessionId), ["shared-2", "isolated-1", "shared-1"]);
});

test("a legacy persisted writer lock no longer blocks runs", async () => {
  const store = new InMemoryProjectStore();
  const projects = new ProjectsService(store);
  const project = await projects.createProject({ path: "/tmp/demo" });
  await store.saveProject({ ...project, activeWriterAttemptId: "stale-from-crash" });
  await projects.acquireWriter(project.id, "fresh", { sessionId: "s1", mode: "shared" });
  assert.deepEqual(projects.activeWriters(project.id).map((writer) => writer.attemptId), ["fresh"]);
});

/** In-memory provider that records calls; directories "exist" until removed. */
class FakeProvider implements IsolatedWorkspaceProvider {
  readonly created: string[] = [];
  readonly restored: string[] = [];
  readonly live = new Set<string>();
  unsupported: string | undefined;

  async unsupportedReason(): Promise<string | undefined> { return this.unsupported; }
  async create(request: { readonly projectPath: string; readonly worktreesRoot: string; readonly sessionId: string }) {
    this.created.push(request.sessionId);
    const worktreePath = `${request.worktreesRoot}/${request.sessionId}`;
    this.live.add(worktreePath);
    return {
      sessionId: request.sessionId, worktreePath, path: worktreePath, branch: `rack/${request.sessionId}`,
      baseRef: "main", baseCommit: "a".repeat(40), checkoutRoot: request.projectPath,
    };
  }
  async exists(workspace: IsolatedWorkspace): Promise<boolean> { return this.live.has(workspace.worktreePath); }
  async restore(workspace: IsolatedWorkspace): Promise<void> { this.restored.push(workspace.sessionId); this.live.add(workspace.worktreePath); }
  async status(): Promise<{ readonly dirty: boolean; readonly commitsAhead: number }> { return { dirty: false, commitsAhead: 0 }; }
  async remove(workspace: IsolatedWorkspace): Promise<void> { this.live.delete(workspace.worktreePath); }
}

test("isolated sessions get one persisted worktree, recreated after removal", async () => {
  const provider = new FakeProvider();
  const store = new InMemoryProjectStore();
  const projects = new ProjectsService(store, { isolation: { provider, worktreesRoot: "/data/worktrees" } });
  const project = await projects.createProject({ path: "/tmp/demo" });

  assert.deepEqual(await projects.prepareExecutionDirectory(project.id, "shared-1", "shared"), { path: "/tmp/demo" });
  // Parallel first runs of one session must not create two worktrees.
  const [first, second] = await Promise.all([
    projects.prepareExecutionDirectory(project.id, "iso", "isolated"),
    projects.prepareExecutionDirectory(project.id, "iso", "isolated"),
  ]);
  assert.equal(first.path, "/data/worktrees/iso");
  assert.equal(second.path, first.path);
  assert.deepEqual(provider.created, ["iso"]);
  assert.equal((await store.getProject(project.id))?.isolatedWorkspaces?.[0]?.branch, "rack/iso");

  await projects.removeIsolatedWorkspace(project.id, "iso", false);
  assert.equal((await projects.workspaceState(project.id, "iso", "isolated")).exists, false);
  await projects.prepareExecutionDirectory(project.id, "iso", "isolated");
  assert.deepEqual(provider.restored, ["iso"]);
  assert.deepEqual(provider.created, ["iso"], "restoring reuses the branch instead of creating another worktree");
});

test("worktree removal is refused while the session runs; unsupported projects cannot isolate", async () => {
  const provider = new FakeProvider();
  const projects = new ProjectsService(new InMemoryProjectStore(), { isolation: { provider, worktreesRoot: "/w" } });
  const project = await projects.createProject({ path: "/tmp/demo" });
  await projects.prepareExecutionDirectory(project.id, "iso", "isolated");
  await projects.acquireWriter(project.id, "a1", { sessionId: "iso", mode: "isolated" });
  await assert.rejects(projects.removeIsolatedWorkspace(project.id, "iso", true), SessionBusyError);
  provider.unsupported = "Not a Git repository.";
  assert.equal(await projects.isolationUnavailableReason(project.id), "Not a Git repository.");
  await assert.rejects(projects.prepareExecutionDirectory(project.id, "other", "isolated"), IsolationUnavailableError);
  const plain = new ProjectsService(new InMemoryProjectStore());
  const plainProject = await plain.createProject({ path: "/tmp/plain" });
  assert.match((await plain.isolationUnavailableReason(plainProject.id)) ?? "", /not available/);
});
