import assert from "node:assert/strict";
import test from "node:test";
import { Controller } from "./controller.js";
import { INITIAL_STATE, Store } from "./store.js";
import type { HostClient } from "./host-client.js";
import type { RunView } from "../../contracts/desktop/views.js";
import type { HostEvent } from "../../contracts/desktop/events.js";
import { foldEvents } from "./transcript.js";
import { initialComposerSelection } from "./features/composer-selection.js";
import type { OrchestraSnapshot } from "../../features/orchestration/types.js";

// The controller is tested with view state, not a browser or native UI.
class ImmediateStore extends Store {
  private value = INITIAL_STATE;
  override get() { return this.value; }
  override update(change: Parameters<Store["update"]>[0]) { this.value = change(this.value); }
}
const stamp = "2026-10-14T00:00:00.000Z";
const run: RunView = { id: "run", sessionId: "session", projectId: "project", prompt: "Task", providerId: "fake", accountId: "account",
  permissionMode: "ask", status: "completed", attemptIds: [], attempts: [], createdAt: stamp, updatedAt: stamp };
const session = { id: "session", projectId: "project", messages: [], continuations: [], createdAt: stamp, updatedAt: stamp };

for (const first of ["sessions", "orchestra"] as const) test(`startup waits for complete routing history when ${first} arrives first`, async () => {
  const store = new ImmediateStore();
  let sessionsReady!: (value: unknown) => void;
  let orchestraReady!: (value: unknown) => void;
  const sessions = new Promise((resolve) => { sessionsReady = resolve; });
  const orchestra = new Promise((resolve) => { orchestraReady = resolve; });
  const history: OrchestraSnapshot = { workflows: [], bindings: {}, runs: [{ id: "newer-workflow", sessionId: session.id, workflow: { id: "definition", name: "Workflow", description: "", revision: 1, steps: [] }, prompt: "Workflow task", status: "completed", stepIndex: 0, workers: [], reviewRounds: {}, revision: 1,
    defaultModel: { providerId: "new-provider", runtimeId: "new-runtime", model: "new-model" }, defaultAccountId: "new-account", permissionMode: "read_only", createdAt: "2026-10-15", updatedAt: "2026-10-15" }] };
  const root = { ...run, model: "old-model", permissionMode: "full_access", attempts: [{ id: "attempt", runtimeId: "old-runtime" }] };
  const host = { onEvent: () => () => {}, call: async (command: string) => {
    if (command === "sessions.list") return sessions;
    if (command === "orchestra.snapshot") return orchestra;
    if (command === "sessions.get") return session;
    if (command === "runs.list") return [root];
    if (command === "models.list") return { models: [], failures: [] };
    if (command === "sessions.workspace") return undefined;
    return [];
  } } as unknown as HostClient;
  const starting = new Controller(host, store).start();
  if (first === "sessions") sessionsReady([session]); else orchestraReady(history);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(store.get().session, undefined, "composer must not see a session before routing history is complete");
  if (first === "sessions") orchestraReady(history); else sessionsReady([session]);
  await starting;
  assert.equal(store.get().session?.id, session.id);
  assert.deepEqual(initialComposerSelection(store.get(), session.id), { model: { key: "new-provider|new-runtime|new-model", label: "new-model" }, account: "account:new-provider:new-account", permissionMode: "read_only" });
});

test("opening a side-chat draft performs no host calls and plain reopening does not replay it", () => {
  const store = new ImmediateStore();
  const controller = new Controller({ call: () => { throw new Error("Opening a draft must not contact a provider"); } } as unknown as HostClient, store);
  controller.openTool("side-chat", "Explain this excerpt");
  assert.deepEqual(store.get().toolRequest, { id: "side-chat", seq: 1, draft: "Explain this excerpt" });
  controller.openTool("side-chat");
  assert.deepEqual(store.get().toolRequest, { id: "side-chat", seq: 2 });
  assert.equal(store.get().page, "chat");
});

test("workflow control suppresses duplicate commands and retains Stop until cancellation settles", async () => {
  const store = new ImmediateStore();
  let finish!: () => void;
  let controls = 0;
  const host = { call: async (command: string) => {
    if (command === "orchestra.control") { controls++; await new Promise<void>((resolve) => { finish = resolve; }); return null; }
    if (command === "orchestra.snapshot") return store.get().orchestra;
    throw new Error(command);
  } } as unknown as HostClient;
  const controller = new Controller(host, store);
  const first = controller.controlWorkflow("workflow", "stop");
  const duplicate = controller.controlWorkflow("workflow", "stop");
  assert.equal(controls, 1);
  assert.deepEqual(store.get().workflowControls?.["workflow"], { action: "stop", pending: true });
  finish(); await Promise.all([first, duplicate]);
  assert.equal(store.get().workflowControls?.["workflow"], undefined);
});

test("failed workflow commands retain an actionable error and allow retry", async () => {
  const store = new ImmediateStore();
  let controls = 0;
  const controller = new Controller({ call: async (command: string) => {
    if (command === "orchestra.control") { if (++controls === 1) throw new Error("Unable to pause"); return null; }
    if (command === "orchestra.snapshot") return store.get().orchestra;
    throw new Error(command);
  } } as unknown as HostClient, store);
  await controller.controlWorkflow("workflow", "pause");
  assert.deepEqual(store.get().workflowControls?.["workflow"], { action: "pause", pending: false, error: "Unable to pause" });
  await controller.controlWorkflow("workflow", "pause");
  assert.equal(controls, 2);
  assert.equal(store.get().workflowControls?.["workflow"], undefined);
});

test("orchestra links retain the exact historical run and worker target", () => {
  const store = new ImmediateStore();
  store.update((state) => ({ ...state, selection: { sessionId: "session" } }));
  const controller = new Controller({ call: () => { throw new Error("Same-session navigation is local"); } } as unknown as HostClient, store);
  const target = { sessionId: "session", workflowRunId: "older-run", workerId: "previous-revision" };
  controller.openOrchestra(target);
  assert.deepEqual(store.get().orchestraTarget, { ...target, seq: 1 });
  assert.equal(store.get().toolRequest?.id, "orchestration");
  controller.openOrchestra(target);
  assert.equal(store.get().orchestraTarget?.seq, 2);
});

test("provider diagnostics suppress duplicate clicks and clear stale successes on retry failure", async () => {
  const store = new ImmediateStore();
  let calls = 0;
  let finish!: (value: unknown) => void;
  const host = { call: async (command: string, params: unknown) => {
    assert.equal(command, "auth.diagnose");
    assert.deepEqual(params, { providerId: "fake", accountId: "account" });
    calls++;
    if (calls === 2) throw new Error("secret provider output");
    return new Promise((resolve) => { finish = resolve; });
  } } as unknown as HostClient;
  const controller = new Controller(host, store);
  const first = controller.diagnoseProvider("fake", "account");
  await controller.diagnoseProvider("fake", "account");
  assert.equal(calls, 1);
  const key = JSON.stringify(["fake", "account"]);
  assert.equal(store.get().providerDiagnostics[key]?.pending, true);
  finish({ status: "ready", stage: "startup", authentication: "not_checked", checkedAt: stamp, message: "Ready" });
  await first;
  assert.equal(store.get().providerDiagnostics[key]?.result?.status, "ready");
  await controller.diagnoseProvider("fake", "account");
  assert.equal(store.get().providerDiagnostics[key]?.result, undefined);
  assert.equal(store.get().providerDiagnostics[key]?.pending, false);
  assert.ok(!JSON.stringify(store.get().providerDiagnostics).includes("secret provider output"));
  const stale = controller.diagnoseProvider("fake", "account");
  // A completed reconnect drops the old context's observation while a check
  // can still be in flight. Its late result must not revive that observation.
  store.update((state) => ({ ...state, providerDiagnostics: {} }));
  finish({ status: "ready" });
  await stale;
  assert.equal(store.get().providerDiagnostics[key], undefined);
});

test("live thinking and response chunks update view state before run completion", async () => {
  const store = new ImmediateStore();
  let emit!: (event: HostEvent) => void;
  const host = { onEvent: (listener: typeof emit) => { emit = listener; return () => {}; }, selectDirectory: async () => undefined,
    call: async (command: string) => command === "models.list" ? { models: [], failures: [] } : [],
  } as unknown as HostClient;
  await new Controller(host, store).start();
  store.update((state) => ({ ...state, session, selection: { projectId: "project", sessionId: "session" } }));
  emit({ type: "run.started", run: { ...run, status: "running" } });
  emit({ type: "run.event", runId: run.id, index: 0, event: { type: "thinking_delta", text: "Checking ", traceId: "trace", format: "trace" } });
  emit({ type: "run.event", runId: run.id, index: 1, event: { type: "thinking_delta", text: "files", traceId: "trace", format: "trace" } });
  emit({ type: "run.event", runId: run.id, index: 2, event: { type: "message_delta", text: "Hello " } });
  const before = store.get().live[run.id]!.events;
  assert.equal(store.get().live[run.id]?.run.status, "running");
  assert.equal(foldEvents(before).items[0]?.kind === "thinking" && foldEvents(before).items[0]?.text, "Checking files");
  emit({ type: "run.event", runId: run.id, index: 3, event: { type: "message_delta", text: "world" } });
  const current = store.get().live[run.id]!.events;
  assert.notEqual(current, before);
  assert.equal(before.length, 3);
  assert.equal(foldEvents(current).items[1]?.kind === "text" && foldEvents(current).items[1]?.text, "Hello world");
});

test("batch import retains successes and reports only failed source selections", async () => {
  const store = new ImmediateStore();
  store.update((state) => ({ ...state, sessions: [{ ...session, messageCount: 0 }] }));
  const calls: string[] = [];
  const host = { onEvent: () => () => {}, selectDirectory: async () => undefined,
    call: async (command: string, params: { nativeSessionId?: string }) => {
      calls.push(command);
      if (command === "sessions.import") {
        if (params.nativeSessionId === "bad") throw new Error("Unavailable source");
        return { session, alreadyImported: false };
      }
      if (command === "sessions.list") return [{ ...session, messageCount: 0 }];
      if (command === "sessions.get") return session;
      if (command === "runs.list" || command === "projects.list") return [];
      if (command === "models.list") return { models: [], failures: [] };
      throw new Error(command);
    },
  } as unknown as HostClient;
  const result = await new Controller(host, store).importSessions("project", [
    { sourceId: "source", nativeSessionId: "good" }, { sourceId: "source", nativeSessionId: "bad" },
  ]);
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0]?.sessionId, session.id);
  assert.deepEqual(result.failed, [{ sourceId: "source", nativeSessionId: "bad" }]);
  assert.equal(calls.filter((command) => command === "sessions.list").length, 1);
  assert.equal(store.get().selection.sessionId, session.id);
});

test("opening a completed session restores saved thinking and tool activity from its journal", async () => {
  const store = new ImmediateStore();
  store.update((state) => ({ ...state, sessions: [{ ...session, messageCount: 0 }] }));
  const host = { onEvent: () => () => {}, selectDirectory: async () => undefined, call: async (command: string) => {
    if (command === "sessions.get") return session;
    if (command === "runs.list") return [run];
    if (command === "projects.list") return [];
    if (command === "models.list") return { models: [], failures: [] };
    if (command === "runs.journal") return [
      { sequence: 1, type: "run_started", payload: {} },
      { sequence: 2, type: "thinking_delta", payload: { type: "thinking_delta", text: "Saved thought", format: "trace" } },
      { sequence: 3, type: "tool_request", payload: { type: "tool_request", tool: "read", input: { path: "file.ts" }, toolCallId: "tool" } },
      { sequence: 4, type: "tool_result", payload: { type: "tool_result", output: "content", toolCallId: "tool" } },
    ];
    throw new Error(command);
  } } as unknown as HostClient;
  await new Controller(host, store).selectSession(session.id);
  assert.equal(store.get().transcripts[run.id]?.length, 3);
  assert.equal(store.get().transcripts[run.id]?.[0]?.type, "thinking_delta");
});

test("opening a chosen repository refreshes projects and selects its normal project identity", async () => {
  const store = new ImmediateStore();
  const project = { id: "repository", path: "/parent/repository", createdAt: stamp, updatedAt: stamp };
  const host = { call: async (command: string) => {
    if (command === "projects.create") return project;
    if (command === "projects.list") return [project];
    if (command === "models.list") return { models: [], failures: [] };
    throw new Error(command);
  } } as unknown as HostClient;
  assert.equal(await new Controller(host, store).createProject({ path: project.path }), true);
  assert.deepEqual(store.get().projects, [project]);
  assert.equal(store.get().selection.projectId, project.id);
  assert.equal(store.get().selection.sessionId, undefined);
});

test("repository creation can finish after navigation without stealing the newer selection", async () => {
  const store = new ImmediateStore();
  store.update((state) => ({ ...state, selection: { projectId: "parent" } }));
  const project = { id: "repository", path: "/parent/repository", createdAt: stamp, updatedAt: stamp };
  let finish!: (value: typeof project) => void;
  const pending = new Promise<typeof project>((resolve) => { finish = resolve; });
  let modelReads = 0;
  const host = { call: async (command: string) => {
    if (command === "projects.create") return pending;
    if (command === "projects.list") return [project];
    if (command === "models.list") { modelReads++; return { models: [], failures: [] }; }
    throw new Error(command);
  } } as unknown as HostClient;
  const controller = new Controller(host, store);
  const opening = controller.createProject({ path: project.path }, () => store.get().selection.projectId === "parent");
  await controller.selectProject("other");
  finish(project);
  assert.equal(await opening, true);
  assert.deepEqual(store.get().projects, [project]);
  assert.equal(store.get().selection.projectId, "other");
  assert.equal(modelReads, 1);
});

test("returning to a recent session immediately restores its transcript without replaying journals", async () => {
  const store = new ImmediateStore();
  const second = { ...session, id: "second" };
  const otherRun = { ...run, id: "other-run", sessionId: second.id };
  store.update((state) => ({ ...state, sessions: [session, second].map((entry) => ({ ...entry, messageCount: 0 })) }));
  let journalReads = 0;
  let modelReads = 0;
  const host = { call: async (command: string, params: { sessionId?: string; runId?: string }) => {
    if (command === "sessions.get") return params.sessionId === session.id ? session : second;
    if (command === "runs.list") return params.sessionId === session.id ? [run] : [otherRun];
    if (command === "runs.journal") { journalReads++; return [{ type: "message_delta", payload: { type: "message_delta", text: params.runId } }]; }
    if (command === "projects.list") return [];
    if (command === "models.list") { modelReads++; return { models: [], failures: [] }; }
    throw new Error(command);
  } } as unknown as HostClient;
  const controller = new Controller(host, store);
  await controller.selectSession(session.id);
  const transcript = store.get().transcripts[run.id];
  await controller.selectSession(second.id);
  const returning = controller.selectSession(session.id);
  assert.equal(store.get().session?.id, session.id);
  assert.equal(store.get().transcripts[run.id], transcript);
  await returning;
  assert.equal(journalReads, 2);
  assert.equal(modelReads, 1);
});

test("session messages appear before a slow journal, and its late reply cannot replace another session", async () => {
  const store = new ImmediateStore();
  const second = { ...session, id: "second" };
  let finish!: (entries: unknown[]) => void;
  let started!: () => void;
  const journal = new Promise<unknown[]>((resolve) => { finish = resolve; });
  const reading = new Promise<void>((resolve) => { started = resolve; });
  const host = { call: async (command: string, params: { sessionId?: string }) => {
    if (command === "sessions.get") return params.sessionId === session.id ? session : second;
    if (command === "runs.list") return params.sessionId === session.id ? [run] : [];
    if (command === "runs.journal") { started(); return journal; }
    if (command === "models.list") return { models: [], failures: [] };
    if (command === "projects.list") return [];
    throw new Error(command);
  } } as unknown as HostClient;
  const controller = new Controller(host, store);
  const first = controller.selectSession(session.id);
  await reading;
  assert.equal(store.get().session?.id, session.id);
  assert.equal(store.get().runs[0]?.id, run.id);
  await controller.selectSession(second.id);
  finish([{ type: "message_delta", payload: { type: "message_delta", text: "saved" } }]);
  await first;
  assert.equal(store.get().session?.id, second.id);
  assert.equal(store.get().transcripts[run.id], undefined);
});

test("a changed persisted run invalidates its cached journal on return", async () => {
  const store = new ImmediateStore();
  let currentRun = run;
  let reads = 0;
  const host = { call: async (command: string) => {
    if (command === "sessions.get") return session;
    if (command === "runs.list") return [currentRun];
    if (command === "runs.journal") { reads++; return [{ type: "message_delta", payload: { type: "message_delta", text: String(reads) } }]; }
    if (command === "models.list") return { models: [], failures: [] };
    throw new Error(command);
  } } as unknown as HostClient;
  const controller = new Controller(host, store);
  await controller.selectSession(session.id);
  await controller.selectProject("elsewhere");
  currentRun = { ...run, updatedAt: "2026-10-15T00:00:00.000Z" };
  await controller.selectSession(session.id);
  assert.equal(reads, 2);
  assert.equal((store.get().transcripts[run.id]?.[0] as { text: string }).text, "2");
});

test("recent-session history retention is bounded and an evicted session is reloaded", async () => {
  const store = new ImmediateStore();
  const sessions = Array.from({ length: 10 }, (_, index) => ({ ...session, id: `session-${index}` }));
  store.update((state) => ({ ...state, sessions: sessions.map((entry) => ({ ...entry, messageCount: 0 })) }));
  const reads = new Map<string, number>();
  const host = { call: async (command: string, params: { sessionId?: string; runId?: string }) => {
    if (command === "sessions.get") return sessions.find((entry) => entry.id === params.sessionId);
    if (command === "runs.list") return [{ ...run, id: `run-${params.sessionId}`, sessionId: params.sessionId }];
    if (command === "runs.journal") { reads.set(params.runId!, (reads.get(params.runId!) ?? 0) + 1); return []; }
    if (command === "models.list") return { models: [], failures: [] };
    if (command === "projects.list") return [];
    throw new Error(command);
  } } as unknown as HostClient;
  const controller = new Controller(host, store);
  for (const entry of sessions) await controller.selectSession(entry.id);
  await controller.selectSession(sessions[0]!.id);
  assert.equal(reads.get("run-session-0"), 2);
});

test("registering a repository for Timeline retains the selected conversation and messages", async () => {
  const store = new ImmediateStore();
  const transcripts = { [run.id]: [{ type: "message_delta" as const, text: "Keep this conversation" }] };
  store.update((state) => ({ ...state, session, runs: [run], transcripts,
    selection: { projectId: session.projectId, sessionId: session.id } }));
  const project = { id: "repository", path: "/parent/repository", createdAt: stamp, updatedAt: stamp };
  const host = { call: async (command: string) => {
    if (command === "projects.create") return project;
    if (command === "projects.list") return [project];
    throw new Error(command);
  } } as unknown as HostClient;
  const registered = await new Controller(host, store).registerProject({ path: project.path });
  assert.equal(registered?.id, project.id);
  assert.equal(store.get().selection.sessionId, session.id);
  assert.equal(store.get().selection.projectId, session.projectId);
  assert.equal(store.get().session, session);
  assert.equal(store.get().transcripts, transcripts);
});

test("removal evicts the selected session and its cached history without resurrecting it", async () => {
  const store = new ImmediateStore();
  store.update((state) => ({ ...state, sessions: [{ ...session, messageCount: 0 }] }));
  let reads = 0;
  const host = { call: async (command: string) => {
    if (command === "sessions.get") { reads++; return session; }
    if (command === "runs.list") return [run];
    if (command === "runs.journal") return [{ type: "message_delta", payload: { type: "message_delta", text: "Saved history" } }];
    if (command === "models.list") return { models: [], failures: [] };
    if (command === "projects.list") return [];
    if (command === "sessions.remove") return null;
    throw new Error(command);
  } } as unknown as HostClient;
  const controller = new Controller(host, store);
  await controller.selectSession(session.id);
  assert.equal(await controller.removeSession(session.id), true);
  assert.equal(store.get().session, undefined);
  assert.deepEqual(store.get().selection, { projectId: session.projectId, sessionId: undefined, runId: undefined });
  assert.deepEqual(store.get().sessions, []);
  assert.deepEqual(store.get().transcripts, {});
  await controller.selectSession(session.id);
  assert.equal(reads, 1);
  assert.equal(store.get().session, undefined);
});

test("removing a background session does not steal a newer selection", async () => {
  const store = new ImmediateStore();
  const second = { ...session, id: "second" };
  store.update((state) => ({ ...state, session, sessions: [session, second].map((entry) => ({ ...entry, messageCount: 0 })),
    selection: { projectId: session.projectId, sessionId: session.id } }));
  let finish!: () => void;
  const pending = new Promise<null>((resolve) => { finish = () => resolve(null); });
  const host = { call: async (command: string) => {
    if (command === "sessions.remove") return pending;
    if (command === "sessions.get") return second;
    if (command === "runs.list") return [];
    throw new Error(command);
  } } as unknown as HostClient;
  const controller = new Controller(host, store);
  const removing = controller.removeSession(session.id);
  await controller.selectSession(second.id);
  finish();
  assert.equal(await removing, true);
  assert.equal(store.get().session?.id, second.id);
  assert.equal(store.get().selection.sessionId, second.id);
});

test("a removal broadcast excludes late journals and stale session-list replies", async () => {
  const store = new ImmediateStore();
  let emit!: (event: HostEvent) => void;
  let finishJournal!: (value: unknown[]) => void;
  let journalStarted!: () => void;
  const reading = new Promise<void>((resolve) => { journalStarted = resolve; });
  const journal = new Promise<unknown[]>((resolve) => { finishJournal = resolve; });
  let finishList!: (value: unknown[]) => void;
  const staleList = new Promise<unknown[]>((resolve) => { finishList = resolve; });
  let lists = 0;
  const host = { onEvent: (listener: typeof emit) => { emit = listener; return () => {}; },
    call: async (command: string) => {
      if (command === "sessions.list") return ++lists === 1 ? [{ ...session, messageCount: 0 }] : staleList;
      if (command === "sessions.get") return session;
      if (command === "runs.list") return [run];
      if (command === "runs.journal") { journalStarted(); return journal; }
      if (command === "models.list") return { models: [], failures: [] };
      return [];
    },
  } as unknown as HostClient;
  const controller = new Controller(host, store);
  const startup = controller.start();
  await reading;
  emit({ type: "sessions.changed", sessionId: session.id, projectId: session.projectId });
  emit({ type: "sessions.removed", sessionId: session.id, projectId: session.projectId });
  finishList([{ ...session, messageCount: 0 }]);
  finishJournal([{ type: "message_delta", payload: { type: "message_delta", text: "Must stay removed" } }]);
  await startup;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(store.get().selection.sessionId, undefined);
  assert.deepEqual(store.get().sessions, []);
  assert.deepEqual(store.get().transcripts, {});
  assert.equal(store.get().notice, undefined);
});

test("host exit replaces loading runs with unknown history and preserves streamed output", async () => {
  const store = new ImmediateStore();
  let emit!: (event: HostEvent) => void;
  const host = { onEvent: (listener: typeof emit) => { emit = listener; return () => {}; }, call: async (command: string) => command === "models.list" ? { models: [], failures: [] } : [] } as unknown as HostClient;
  await new Controller(host, store).start();
  store.update((state) => ({ ...state, session, selection: { projectId: "project", sessionId: "session" } }));
  emit({ type: "run.started", run: { ...run, status: "running" } });
  emit({ type: "run.event", runId: run.id, index: 0, event: { type: "message_delta", text: "Partial work" } });
  store.update((state) => ({ ...state, orchestra: { ...state.orchestra, runs: [{ id: "workflow-run", sessionId: "session", workflow: { id: "workflow", name: "Feature", description: "", revision: 1, steps: [] }, prompt: "Task", status: "running", stepIndex: 0, workers: [], reviewRounds: {}, defaultModel: { providerId: "fake", runtimeId: "fake-runtime", model: "test" }, permissionMode: "ask", revision: 1, createdAt: stamp, updatedAt: stamp }] } }));

  emit({ type: "host.status", status: "exited", detail: "Host stopped" });
  assert.deepEqual(store.get().live, {});
  assert.equal(store.get().runs[0]?.status, "unknown");
  assert.equal(store.get().transcripts[run.id]?.[0]?.type, "message_delta");
  assert.match(store.get().runs[0]?.error ?? "", /host stopped/);
  emit({ type: "run.started", run: { ...run, status: "running" } });
  assert.deepEqual(store.get().live, {}, "late IPC must not resurrect a dead host run");
  assert.equal(store.get().orchestra.runs[0]?.status, "interrupted");
  emit({ type: "orchestra.changed" });
  assert.equal(store.get().orchestra.runs[0]?.status, "interrupted", "late workflow events must not revive running indicators");
});

test("only explicitly confirmed deletion sends force and cancellation errors restore retry", async () => {
  const store = new ImmediateStore();
  const calls: unknown[] = [];
  const host = { call: async (command: string, params: unknown) => {
    calls.push(params); if (command === "runs.cancel") throw new Error("Transport failed"); return null;
  } } as unknown as HostClient;
  const controller = new Controller(host, store);
  assert.equal(await controller.removeSession("ordinary"), true);
  assert.equal(await controller.removeSession("running", true), true);
  assert.deepEqual(calls.slice(0, 2), [{ sessionId: "ordinary" }, { sessionId: "running", force: true }]);
  store.update((state) => ({ ...state, live: { [run.id]: { run: { ...run, status: "running" }, events: [], pendingApprovals: [], decisions: {}, cancelRequested: false } } }));
  await controller.cancelRun(run.id);
  assert.equal(store.get().live[run.id]?.cancelRequested, false);
});

test("switching from a project to chat clears project selection and discards a late project model catalog", async () => {
  const store = new ImmediateStore();
  const chat = { id: "chat", messages: [], continuations: [], createdAt: stamp, updatedAt: stamp };
  store.update((state) => ({ ...state, host: { status: "ready" }, sessions: [
    { ...session, messageCount: 0 }, { ...chat, messageCount: 0 },
  ] }));
  let finish!: (value: unknown) => void;
  const catalogs: unknown[] = [];
  const host = { call: async (command: string, params: any) => {
    if (command === "sessions.get") return params.sessionId === "chat" ? chat : session;
    if (command === "models.list") {
      catalogs.push(params);
      if (catalogs.length === 1) return new Promise((resolve) => { finish = resolve; });
      return { models: [], failures: [] };
    }
    return [];
  } } as unknown as HostClient;
  const controller = new Controller(host, store);
  const projectSelection = controller.selectSession("session");
  const chatSelection = controller.selectSession("chat");
  finish({ models: [{ id: "stale-project-model" }], failures: [] });
  await Promise.all([projectSelection, chatSelection]);
  assert.equal(store.get().selection.projectId, undefined);
  assert.equal(store.get().selection.sessionId, "chat");
  assert.deepEqual(catalogs, [{ projectId: "project" }, {}]);
  assert.deepEqual(store.get().models, []);
});

test("explicit chat editor targets keep their workspace when another project is selected", async () => {
  const store = new ImmediateStore();
  store.update((state) => ({ ...state, projects: [{ id: "other", path: "/other-project", createdAt: stamp, updatedAt: stamp }], selection: { projectId: "other" } }));
  const host = { call: async (command: string, params: unknown) => {
    assert.equal(command, "sessions.directory"); assert.deepEqual(params, { sessionId: "original-chat" }); return "/chat-files/original-chat";
  } } as unknown as HostClient;
  const target = await new Controller(host, store).resolveEditorTarget("report.md", undefined, "original-chat");
  assert.deepEqual(target, { path: "report.md", base: "/chat-files/original-chat" });
});

test("startup publishes sessions without waiting for a stalled provider catalog", async () => {
  const store = new ImmediateStore();
  let finishModels!: (value: unknown) => void;
  let requested = 0;
  const host = { onEvent: () => () => {}, call: async (command: string) => {
    if (command === "models.list") { requested++; return new Promise(resolve => { finishModels = resolve; }); }
    if (command === "sessions.list") return [{ ...session, messageCount: 0 }];
    if (command === "sessions.get") return session;
    return [];
  } } as unknown as HostClient;
  await new Controller(host, store).start();
  assert.equal(store.get().host.status, "ready");
  assert.equal(store.get().session?.id, session.id);
  assert.equal(requested, 1, "discovery starts once in the selected context");
  finishModels({ models: [], failures: [] });
});

test("history initially fetches only the latest page with bounded concurrency", async () => {
  const store = new ImmediateStore();
  const runs = Array.from({ length: 120 }, (_, index) => ({ ...run, id: `run-${index}` }));
  let reads = 0, active = 0, peak = 0;
  const host = { call: async (command: string) => {
    if (command === "sessions.get") return session;
    if (command === "runs.list") return runs;
    if (command === "models.list") return { models: [], failures: [] };
    if (command === "runs.journal") {
      reads++; active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1)); active--; return [];
    }
    return [];
  } } as unknown as HostClient;
  const controller = new Controller(host, store);
  await controller.selectSession(session.id);
  assert.equal(reads, 50); assert.ok(peak <= 4);
  await controller.loadSessionActivity(runs.slice(-100).map(run => run.id));
  assert.equal(reads, 100); assert.ok(peak <= 4);
  assert.equal(store.get().transcripts["run-0"], undefined);
  assert.deepEqual(store.get().transcripts["run-20"], []);
});

test("editor targets default to the selected session directory rather than the main checkout", async () => {
  const store = new ImmediateStore();
  store.update(state => ({ ...state, session: { ...session, workspaceMode: "isolated" }, selection: { projectId: "project", sessionId: session.id },
    projects: [{ id: "project", path: "/main-checkout", createdAt: stamp, updatedAt: stamp }] }));
  const host = { call: async (command: string, params: unknown) => {
    assert.equal(command, "sessions.directory"); assert.deepEqual(params, { sessionId: session.id }); return "/session-worktree";
  } } as unknown as HostClient;
  assert.deepEqual(await new Controller(host, store).resolveEditorTarget("src/app.ts"), { path: "src/app.ts", base: "/session-worktree" });
});

test("late workspace inspection cannot replace the newly selected session's directory", async () => {
  const store = new ImmediateStore();
  const other = { ...session, id: "other", workspaceMode: "isolated" as const };
  let finish!: (value: unknown) => void;
  const host = { call: async (command: string, params: { sessionId: string }) => {
    if (command === "sessions.get") return params.sessionId === other.id ? other : session;
    if (command === "sessions.workspace") return params.sessionId === other.id
      ? { mode: "isolated", exists: true, path: "/other-worktree" }
      : new Promise(resolve => { finish = resolve; });
    if (command === "models.list") return { models: [], failures: [] };
    return [];
  } } as unknown as HostClient;
  const controller = new Controller(host, store);
  await controller.selectSession(session.id);
  await controller.selectSession(other.id);
  finish({ mode: "shared", exists: true, path: "/main-checkout" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.get().selection.sessionId, other.id);
  assert.equal(store.get().workspace?.path, "/other-worktree");
});
