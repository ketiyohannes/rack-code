import assert from "node:assert/strict";
import test from "node:test";
import { AccountsService } from "../accounts/service.js";
import { InMemoryAccountStore } from "../accounts/in-memory-store.js";
import { ProjectsService } from "../projects/service.js";
import { InMemoryProjectStore } from "../projects/in-memory-store.js";
import { SessionsService } from "../sessions/service.js";
import { InMemorySessionStore } from "../sessions/in-memory-store.js";
import { InMemoryExecutionStore } from "./in-memory-store.js";
import { ExecutionService } from "./service.js";
import { RuntimeRegistry } from "./runtime-registry.js";
import type { RuntimeAdapter, RuntimeEvent, RuntimeRunInput } from "./types.js";

/** Exercise the app-owned tool boundary through a real execution, including
 * approval parking and cancellation, without starting any provider process.
 */
for (const mode of ["read_only", "ask", "approve_for_me", "full_access"] as const) {
  test(`app tools enforce ${mode} before invoking mutations`, { timeout: 3000 }, async () => {
    const accounts = new AccountsService(new InMemoryAccountStore());
    await accounts.register({ id: "account", providerId: "test", identity: { providerAccountId: "test" }, credential: { id: "credential", providerId: "test", method: "test" }, runtimeContextId: "context", availability: "available" });
    const projects = new ProjectsService(new InMemoryProjectStore());
    const project = await projects.createProject({ path: "/tmp/project" });
    const sessions = new SessionsService(new InMemorySessionStore());
    const session = await sessions.create({ projectId: project.id });
    const invoked: unknown[] = [];
    let denied = false;
    const run = async function* (input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
      const tool = input.tools![0]!;
      await tool.execute({ action: "snapshot" });
      try { await tool.execute({ action: "click" }); } catch { denied = true; }
      yield input.signal.aborted ? { type: "interrupted" } : { type: "completed", result: "done" };
    };
    const runtime: RuntimeAdapter = {
      runtimeId: "test", startRun: run, resumeRun: run, cancel: async () => {}, describePermissionMode: () => "test",
      capabilities: async () => ({ resume: true, fork: false, approvals: true, quotaReporting: false, browserTools: false, computerUse: false }),
    };
    const runtimes = new RuntimeRegistry(); runtimes.register(runtime);
    const service = new ExecutionService(new InMemoryExecutionStore(), accounts, sessions, projects, runtimes, { tools: () => [{
      name: "rack_browser", description: "test", inputSchema: {},
      isMutation: (args) => (args as { action: string }).action !== "snapshot",
      execute: async (args) => { invoked.push(args); return "ok"; },
    }] });
    const handle = await service.start({ sessionId: session.id, projectId: project.id, providerId: "test", runtimeId: "test", prompt: "test", permissionMode: mode });
    let approvals = 0;
    for await (const event of handle.events) {
      if (event.type === "approval_request") { approvals++; handle.respondToApproval(event.request.id, "allow"); }
    }
    assert.equal((await handle.completed).status, "completed");
    assert.equal(denied, mode === "read_only");
    assert.equal(invoked.length, mode === "read_only" ? 1 : 2);
    assert.equal(approvals, mode === "ask" ? 1 : 0);
    assert.equal((await projects.getProject(project.id)).activeWriterAttemptId, undefined);
    if (mode === "ask") {
      const deniedRun = await service.start({ sessionId: session.id, projectId: project.id, providerId: "test", runtimeId: "test", prompt: "deny", permissionMode: mode });
      for await (const event of deniedRun.events) if (event.type === "approval_request") deniedRun.respondToApproval(event.request.id, "deny");
      await deniedRun.completed;
      assert.equal(denied, true);
      assert.equal(invoked.length, 3, "denial permits the snapshot but cannot invoke the mutation");
      const interrupted = await service.start({ sessionId: session.id, projectId: project.id, providerId: "test", runtimeId: "test", prompt: "cancel", permissionMode: mode });
      for await (const event of interrupted.events) if (event.type === "approval_request") await interrupted.cancel();
      assert.equal((await interrupted.completed).status, "interrupted");
      assert.equal(invoked.length, 4, "cancellation cannot release a pending mutation");
    }
  });
}
