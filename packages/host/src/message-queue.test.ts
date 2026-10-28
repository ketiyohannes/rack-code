/**
 * Host behavior of the message queue and of editing an earlier message:
 * queued messages start in order when a run completes, pause on failure or
 * Stop, survive a host restart paused, and an edit replaces later turns.
 * Uses a scripted runtime whose turns the test finishes one at a time.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryAccountStore } from "@rack/core/accounts/in-memory-store";
import { AccountsService } from "@rack/core/accounts/service";
import { InMemoryExecutionStore } from "@rack/core/execution/in-memory-store";
import { RuntimeRegistry } from "@rack/core/execution/runtime-registry";
import { ExecutionService } from "@rack/core/execution/service";
import type { RuntimeAccountContext, RuntimeAdapter, RuntimeCapabilities, RuntimeEvent, RuntimeRunInput } from "@rack/core/execution/types";
import { InMemoryProjectStore } from "@rack/core/projects/in-memory-store";
import { ProjectsService } from "@rack/core/projects/service";
import { InMemorySessionStore } from "@rack/core/sessions/in-memory-store";
import { SessionsService } from "@rack/core/sessions/service";
import { SessionImportsService } from "@rack/core/session-imports/service";
import { ConnectionsService } from "@rack/core/connections/service";
import type { HostEvent } from "@rack/contracts";
import type { QueuedMessageView, RunView, SessionView, StartRunResult } from "@rack/contracts/views";
import type { OrchestraService } from "@rack/features/orchestration/service";
import type { OrchestraSnapshot } from "@rack/features/orchestration/types";
import { HostApi } from "./host-api.js";

type Outcome = "complete" | "fail";

/**
 * Each turn records the prompt it received and waits until the test calls
 * `finish(outcome)`. Abort ends the turn as interrupted, like a real Stop.
 */
class ScriptedRuntime implements RuntimeAdapter {
  readonly runtimeId = "scripted-runtime";
  readonly providerId = "fake";
  readonly prompts: string[] = [];
  private readonly waiting: Array<(outcome: Outcome) => void> = [];
  private thread = 0;

  async capabilities(_account: RuntimeAccountContext): Promise<RuntimeCapabilities> {
    return { resume: true, fork: false, approvals: true, quotaReporting: false, browserTools: false, computerUse: false };
  }
  describePermissionMode(mode: string): string { return mode; }
  async cancel(): Promise<void> {}

  /** Number of turns currently waiting for `finish`. */
  get pending(): number { return this.waiting.length; }

  /** Ends the oldest waiting turn. */
  finish(outcome: Outcome): void {
    const next = this.waiting.shift();
    assert.ok(next, "no turn is waiting");
    next(outcome);
  }

  async *startRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    yield* this.turn(input, `thread-${++this.thread}`);
  }

  async *resumeRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    yield* this.turn(input, input.continuation!.nativeSessionId);
  }

  private async *turn(input: RuntimeRunInput, thread: string): AsyncIterable<RuntimeEvent> {
    this.prompts.push(input.prompt);
    yield { type: "native_session", nativeSessionId: thread };
    const outcome = await new Promise<Outcome | "interrupted">((resolve) => {
      const onAbort = () => { this.waiting.splice(this.waiting.indexOf(release), 1); resolve("interrupted"); };
      const release = (value: Outcome) => { input.signal.removeEventListener("abort", onAbort); resolve(value); };
      this.waiting.push(release);
      input.signal.addEventListener("abort", onAbort, { once: true });
    });
    if (outcome === "interrupted") { yield { type: "interrupted" }; return; }
    if (outcome === "fail") { yield { type: "failed", error: "scripted failure" }; return; }
    const reply = `reply to ${input.prompt.split("\n").at(-1)}`;
    yield { type: "message_delta", text: reply };
    yield { type: "completed", result: reply };
  }
}

/**
 * The slice of Orchestration the host consults for queue and edit refusals:
 * bindings and workflow runs. The test mutates `snapshot` directly.
 */
function fakeOrchestra(): { service: OrchestraService; snapshot: { bindings: Record<string, string>; runs: Array<{ id: string; sessionId: string; createdAt: string }> } } {
  const snapshot = { bindings: {} as Record<string, string>, runs: [] as Array<{ id: string; sessionId: string; createdAt: string }> };
  const service = {
    initialize: async () => {},
    subscribe: () => () => {},
    observeExecutions: () => {},
    isBusy: () => false,
    stopAll: async () => {},
    snapshot: async () => ({ workflows: [], ...snapshot }) as unknown as OrchestraSnapshot,
  } as unknown as OrchestraService;
  return { service, snapshot };
}

async function setup(options: { orchestra?: OrchestraService } = {}) {
  const accounts = new AccountsService(new InMemoryAccountStore());
  const projects = new ProjectsService(new InMemoryProjectStore());
  const sessionStore = new InMemorySessionStore();
  const sessions = new SessionsService(sessionStore);
  const runtimes = new RuntimeRegistry();
  const runtime = new ScriptedRuntime();
  runtimes.register(runtime);
  const executionStore = new InMemoryExecutionStore();
  const execution = new ExecutionService(executionStore, accounts, sessions, projects, runtimes, { cancelTimeoutMs: 20 });
  const connections = new ConnectionsService(accounts, { resolve: async (id) => ({ directory: `/contexts/${id}` }) }, []);
  const events: HostEvent[] = [];
  const sessionImports = new SessionImportsService(projects, sessions, []);
  const app = { accounts, projects, sessions, sessionImports, execution, runtimes, connections, ...(options.orchestra === undefined ? {} : { orchestra: options.orchestra }) };
  const api = new HostApi(app, (event) => events.push(event));
  const call = async <T>(command: string, params: unknown = {}): Promise<T> => {
    const response = await api.dispatch(command, params);
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
    return response.value as T;
  };
  const project = await call<{ id: string }>("projects.create", { path: "/tmp/queue-demo" });
  const session = await call<{ id: string }>("sessions.create", { projectId: project.id });
  const account = await call<{ id: string }>("accounts.register", {
    providerId: "fake", providerAccountId: "user-1",
    credential: { id: "cred-1", providerId: "fake", method: "token" }, runtimeContextId: "ctx-1",
  });
  // Edits choose the account by normal selection, which needs an available one.
  await accounts.updateAvailability(account.id, { status: "available" });
  const settings = { providerId: "fake", runtimeId: runtime.runtimeId, accountId: account.id, permissionMode: "full_access" };
  const send = (prompt: string) => call<StartRunResult>("runs.start", { sessionId: session.id, projectId: project.id, prompt, ...settings });
  const queue = (prompt: string) => call<{ item: QueuedMessageView; started?: StartRunResult }>("queue.add", { sessionId: session.id, prompt, settings });
  const read = () => call<SessionView>("sessions.get", { sessionId: session.id });
  const runs = () => call<RunView[]>("runs.list", { sessionId: session.id });
  /** Waits until `count` runs of the session have settled. */
  const settled = (count: number) => waitUntil(async () => (await runs()).filter((run) => !["queued", "running"].includes(run.status)).length >= count);
  /** Waits until the runtime holds `count` waiting turns. */
  const turns = (count: number) => waitUntil(() => runtime.pending === count);
  return { api, app, call, events, runtime, session, project, send, queue, read, runs, settled, turns, sessionStore, executionStore };
}

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("queued messages run in order after each completed turn", { timeout: 5000 }, async () => {
  const fixture = await setup();
  await fixture.send("A");
  await fixture.turns(1);
  const b = await fixture.queue("B");
  const c = await fixture.queue("C");
  assert.equal(b.started, undefined, "a busy session queues instead of starting");
  await fixture.call("queue.update", { sessionId: fixture.session.id, itemId: c.item.id, prompt: "C edited" });
  assert.deepEqual((await fixture.read()).queue?.items.map((item) => item.prompt), ["B", "C edited"]);
  assert.ok(fixture.events.some((event) => event.type === "sessions.changed" && event.sessionId === fixture.session.id));

  fixture.runtime.finish("complete");
  await fixture.turns(1);
  assert.deepEqual((await fixture.read()).queue?.items.map((item) => item.prompt), ["C edited"]);
  fixture.runtime.finish("complete");
  await fixture.turns(1);
  assert.equal((await fixture.read()).queue, undefined);
  fixture.runtime.finish("complete");
  await fixture.settled(3);
  assert.deepEqual((await fixture.runs()).map((run) => run.prompt), ["A", "B", "C edited"]);
  // Each queued turn ran with the conversation so far and its own prompt last.
  assert.match(fixture.runtime.prompts[2]!, /C edited$/);
});

test("a failed or stopped turn pauses the queue until the user resumes or sends", { timeout: 5000 }, async () => {
  const fixture = await setup();
  const first = await fixture.send("A");
  await fixture.turns(1);
  await fixture.queue("B");
  fixture.runtime.finish("fail");
  await waitUntil(async () => (await fixture.read()).queue?.pausedReason === "run_failed");
  assert.equal(fixture.runtime.pending, 0, "nothing started after a failure");

  // Adding to a paused queue while idle does not start anything.
  const c = await fixture.queue("C");
  assert.equal(c.started, undefined);

  // Resume clears the pause and starts the oldest item.
  const resumed = await fixture.call<{ started?: StartRunResult }>("queue.resume", { sessionId: fixture.session.id });
  assert.equal(resumed.started?.run.prompt, "B");
  await fixture.turns(1);

  // Stop counts as an interruption and pauses again.
  await fixture.call("runs.cancel", { runId: resumed.started!.run.id });
  await waitUntil(async () => (await fixture.read()).queue?.pausedReason === "run_interrupted");

  // A manual send clears the pause, so the queue continues after it.
  await fixture.send("manual");
  assert.equal((await fixture.read()).queue?.pausedReason, undefined);
  await fixture.turns(1);
  fixture.runtime.finish("complete");
  await fixture.turns(1);
  assert.equal((await fixture.runs()).at(-1)?.prompt, "C");
  fixture.runtime.finish("complete");
  await fixture.settled(4);
  assert.equal(first.run.prompt, "A");
});

test("Send now stops the current turn and runs that item next, keeping the rest in order", { timeout: 5000 }, async () => {
  const fixture = await setup();
  await fixture.send("A");
  await fixture.turns(1);
  await fixture.queue("B");
  const c = await fixture.queue("C");
  const result = await fixture.call<{ started?: StartRunResult }>("queue.sendNow", { sessionId: fixture.session.id, itemId: c.item.id });
  assert.equal(result.started, undefined, "the item starts when the cancelled run settles");
  await waitUntil(async () => (await fixture.runs()).at(-1)?.prompt === "C");
  const runs = await fixture.runs();
  assert.equal(runs[0]?.status, "interrupted");
  const session = await fixture.read();
  assert.deepEqual(session.queue?.items.map((item) => item.prompt), ["B"]);
  assert.equal(session.queue?.pausedReason, undefined, "the interruption caused by Send now does not pause");
  assert.equal(session.queue?.sendNowItemId, undefined);
  fixture.runtime.finish("complete");
  await fixture.turns(1);
  fixture.runtime.finish("complete");
  await fixture.settled(3);
  assert.deepEqual((await fixture.runs()).map((run) => run.prompt), ["A", "C", "B"]);

  // On an idle session Send now starts the item at once.
  const d = await fixture.queue("D");
  assert.equal(d.started?.run.prompt, "D", "an idle, unpaused session starts a queued message immediately");
  await fixture.turns(1);
  fixture.runtime.finish("complete");
  await fixture.settled(4);
});

test("a queued message whose start fails returns to the queue and pauses it", { timeout: 5000 }, async () => {
  const fixture = await setup();
  await fixture.send("A");
  await fixture.turns(1);
  // The account it names disappears before the item can start.
  await fixture.call("queue.add", { sessionId: fixture.session.id, prompt: "B", settings: { providerId: "fake", runtimeId: "scripted-runtime", permissionMode: "ask", accountId: "missing-account" } });
  fixture.runtime.finish("complete");
  await waitUntil(async () => (await fixture.read()).queue?.pausedReason === "start_failed");
  const session = await fixture.read();
  assert.deepEqual(session.queue?.items.map((item) => item.prompt), ["B"]);
  assert.ok(session.queue?.pausedError);
  assert.equal((await fixture.runs()).length, 1);
});

test("queues are refused in worker sessions and validated by the contract", async () => {
  const fixture = await setup();
  const missing = await fixture.api.dispatch("queue.add", { sessionId: fixture.session.id, prompt: "x", settings: { providerId: "fake", runtimeId: "r", permissionMode: "nope" } });
  assert.equal(!missing.ok && missing.error.code, "invalid_input");
  const worker = await fixture.app.sessions.create({ parentSessionId: fixture.session.id, projectId: fixture.project.id });
  const refused = await fixture.api.dispatch("queue.add", { sessionId: worker.id, prompt: "x", settings: { providerId: "fake", runtimeId: "scripted-runtime", permissionMode: "ask" } });
  assert.equal(!refused.ok && refused.error.code, "invalid_input");
  const stale = await fixture.api.dispatch("queue.remove", { sessionId: fixture.session.id, itemId: "gone" });
  assert.equal(!stale.ok && stale.error.code, "invalid_input");
});

test("a host restart leaves waiting messages paused", { timeout: 5000 }, async () => {
  const fixture = await setup();
  await fixture.send("A");
  await fixture.turns(1);
  await fixture.queue("B");
  // A new host over the same stores stands in for the next app start.
  const restarted = new HostApi(fixture.app, () => {});
  const response = await restarted.dispatch("sessions.get", { sessionId: fixture.session.id });
  assert.ok(response.ok);
  assert.equal((response.value as SessionView).queue?.pausedReason, "host_restarted");
  fixture.runtime.finish("complete");
  await fixture.settled(1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fixture.runtime.pending, 0, "a paused queue does not start after the restart");
});

test("editing an earlier message replaces later turns and keeps their journals", { timeout: 5000 }, async () => {
  const fixture = await setup();
  const first = await fixture.send("first");
  await fixture.turns(1); fixture.runtime.finish("complete"); await fixture.settled(1);
  const second = await fixture.send("second");
  await fixture.turns(1); fixture.runtime.finish("complete"); await fixture.settled(2);
  await fixture.send("third");
  await fixture.turns(1);

  // Editing is refused while the session runs.
  const busy = await fixture.api.dispatch("runs.edit", { runId: second.run.id, prompt: "second, reworded" });
  assert.equal(!busy.ok && busy.error.code, "session_busy");
  assert.equal((await fixture.read()).supersededRunIds, undefined);
  fixture.runtime.finish("complete");
  await fixture.settled(3);

  const edited = await fixture.call<StartRunResult>("runs.edit", { runId: second.run.id, prompt: "second, reworded" });
  assert.equal(edited.run.editOfRunId, second.run.id);
  assert.equal(edited.run.permissionMode, "full_access", "the edit keeps the original turn's settings");
  const session = await fixture.read();
  assert.equal(session.supersededRunIds?.length, 2);
  assert.ok(session.supersededRunIds?.includes(second.run.id));
  await fixture.turns(1);
  const prompt = fixture.runtime.prompts.at(-1)!;
  assert.match(prompt, /first/);
  assert.match(prompt, /second, reworded$/);
  assert.doesNotMatch(prompt, /reply to second|third/);
  fixture.runtime.finish("complete");
  await fixture.settled(4);
  // Every run, including replaced ones, is still listed and auditable.
  assert.equal((await fixture.runs()).length, 4);
  assert.ok((await fixture.call<unknown[]>("runs.journal", { runId: second.run.id })).length > 0);
  // A replaced turn cannot be edited again.
  const stale = await fixture.api.dispatch("runs.edit", { runId: second.run.id, prompt: "again" });
  assert.equal(!stale.ok && stale.error.code, "invalid_input");
  assert.equal(first.run.prompt, "first");
});

test("messages in a conversation that runs a workflow cannot be edited", { timeout: 5000 }, async () => {
  const orchestra = fakeOrchestra();
  const fixture = await setup({ orchestra: orchestra.service });
  const first = await fixture.send("first");
  await fixture.turns(1); fixture.runtime.finish("complete"); await fixture.settled(1);
  const promptsBefore = fixture.runtime.prompts.length;
  const unchanged = async () => {
    assert.equal((await fixture.read()).supersededRunIds, undefined, "no turn was replaced");
    assert.equal((await fixture.runs()).length, 1, "no run was started");
    assert.equal(fixture.runtime.prompts.length, promptsBefore);
  };

  // A workflow turn after the edited message would be skipped by a plain resend.
  orchestra.snapshot.runs.push({ id: "workflow-run", sessionId: fixture.session.id, createdAt: new Date(Date.now() + 1000).toISOString() });
  const later = await fixture.api.dispatch("runs.edit", { runId: first.run.id, prompt: "reworded" });
  assert.equal(!later.ok && later.error.code, "invalid_input");
  assert.match(!later.ok ? later.error.message : "", /runs a workflow/);
  await unchanged();

  // Bound to a workflow, even before its first workflow turn.
  orchestra.snapshot.runs.length = 0;
  orchestra.snapshot.bindings[fixture.session.id] = "workflow-1";
  const bound = await fixture.api.dispatch("runs.edit", { runId: first.run.id, prompt: "reworded" });
  assert.equal(!bound.ok && bound.error.code, "invalid_input");
  await unchanged();

  // Another conversation's binding or workflow turn does not block the edit.
  delete orchestra.snapshot.bindings[fixture.session.id];
  orchestra.snapshot.bindings["other-session"] = "workflow-1";
  orchestra.snapshot.runs.push({ id: "elsewhere", sessionId: "other-session", createdAt: new Date(Date.now() + 1000).toISOString() });
  const edited = await fixture.call<StartRunResult>("runs.edit", { runId: first.run.id, prompt: "reworded" });
  assert.equal(edited.run.editOfRunId, first.run.id);
  await fixture.turns(1); fixture.runtime.finish("complete"); await fixture.settled(2);
});
