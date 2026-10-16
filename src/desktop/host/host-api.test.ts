import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryAccountStore } from "../../core/accounts/in-memory-store.js";
import { AccountsService } from "../../core/accounts/service.js";
import { InMemoryExecutionStore } from "../../core/execution/in-memory-store.js";
import { RuntimeRegistry } from "../../core/execution/runtime-registry.js";
import { ExecutionService } from "../../core/execution/service.js";
import type {
  RuntimeAccountContext,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeModel,
  RuntimeModelInput,
  RuntimeRunInput,
} from "../../core/execution/types.js";
import { InMemoryProjectStore } from "../../core/projects/in-memory-store.js";
import { ProjectsService } from "../../core/projects/service.js";
import { InMemorySessionStore } from "../../core/sessions/in-memory-store.js";
import { SessionsService } from "../../core/sessions/service.js";
import { SessionImportsService } from "../../core/session-imports/service.js";
import type { CommandResponse, HostEvent } from "../../contracts/desktop/index.js";
import { ConnectionsService, NATIVE_LOGIN_METHOD } from "../../core/connections/service.js";
import type { AccountConnector, ConnectAttempt, ConnectContext, ConnectEvent } from "../../core/connections/ports.js";
import { AsyncQueue } from "../../core/shared/async-queue.js";
import { HostApi } from "./host-api.js";

/** Runtime that asks for one approval, then completes. */
class ApprovalRuntime implements RuntimeAdapter {
  readonly runtimeId: string = "approval-runtime";
  readonly providerId = "fake";

  async models(input: RuntimeModelInput): Promise<readonly RuntimeModel[]> {
    if (input.account.credential.id === "catalog-fail") throw new Error("catalog unavailable");
    return [{
      id: "fake-model",
      label: "Fake Model",
      providerId: "fake",
      description: "A model supplied by the fake provider.",
      isDefault: true,
    }] as const;
  }

  async capabilities(_account: RuntimeAccountContext): Promise<RuntimeCapabilities> {
    return { resume: true, fork: false, approvals: true, quotaReporting: false, browserTools: false, computerUse: false };
  }

  describePermissionMode(mode: string): string {
    return `native ${mode}`;
  }

  async *startRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    yield { type: "native_session", nativeSessionId: "native-1" };
    const decision = await input.requestApproval({ tool: "write", input: { path: "a.txt" } });
    yield { type: "tool_result", output: { decision } };
    yield { type: "message_delta", text: "hello" };
    yield { type: "completed", result: "hello" };
  }

  resumeRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    return this.startRun(input);
  }

  async cancel(): Promise<void> {}
}

/** Runtime that blocks until cancelled. */
class BlockingRuntime extends ApprovalRuntime {
  override readonly runtimeId = "blocking-runtime";

  override async models(_input: RuntimeModelInput): Promise<readonly RuntimeModel[]> {
    return [];
  }

  override async *startRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    yield { type: "native_session", nativeSessionId: "native-2" };
    if (!input.signal.aborted) {
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    }
    yield { type: "interrupted" };
  }
}

class QuestionRuntime extends ApprovalRuntime {
  override readonly runtimeId = "question-runtime";
  override async *startRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    yield { type: "native_session", nativeSessionId: "question-native" };
    const response = await input.requestQuestions!([{ id: "format", question: "Which format?", options: [{ label: "Short" }, { label: "Long" }], multiSelect: false, allowCustom: true }]);
    if (response === null) { yield { type: "interrupted" }; return; }
    yield { type: "message_delta", text: response.answers["format"]!.join(", ") };
    yield { type: "completed", result: "answered" };
  }
}

/**
 * Connector whose sign-in is driven by the test: it reports a browser URL
 * and asks for a code, then completes with the identity the code names.
 */
class FakeConnector implements AccountConnector {
  readonly providerId = "fake";
  readonly displayName = "Fake";
  readonly contexts: ConnectContext[] = [];
  cancelled = 0;

  connect(context: ConnectContext): ConnectAttempt {
    this.contexts.push(context);
    const events = new AsyncQueue<ConnectEvent>();
    events.push({ type: "browser", url: "https://example.test/sign-in", opened: false });
    events.push({ type: "code_required" });
    return {
      events,
      submitCode: (code) => {
        events.push({ type: "completed", identity: { providerAccountId: code, email: `${code}@example.test`, plan: "pro" } });
        events.complete();
      },
      cancel: async () => {
        this.cancelled += 1;
        events.complete();
      },
    };
  }
}

/** Ignores both abort and graceful cancellation; only owned-process termination works. */
class HungRuntime extends ApprovalRuntime {
  override readonly runtimeId = "hung-runtime";
  readonly output = new AsyncQueue<RuntimeEvent>();
  stopped = false;
  override async models(_input: RuntimeModelInput): Promise<readonly RuntimeModel[]> { return []; }
  override startRun(_input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    this.output.push({ type: "message_delta", text: "partial output" });
    return this.output;
  }
  override cancel(): Promise<void> { return new Promise(() => {}); }
  async forceCancel(): Promise<void> { this.stopped = true; }
}

async function setup(withQuestions = false) {
  const accounts = new AccountsService(new InMemoryAccountStore());
  const projects = new ProjectsService(new InMemoryProjectStore());
  const sessions = new SessionsService(new InMemorySessionStore());
  const runtimes = new RuntimeRegistry();
  runtimes.register(new ApprovalRuntime());
  runtimes.register(new BlockingRuntime());
  if (withQuestions) runtimes.register(new QuestionRuntime());
  const hung = new HungRuntime(); runtimes.register(hung);
  const execution = new ExecutionService(new InMemoryExecutionStore(), accounts, sessions, projects, runtimes, { cancelTimeoutMs: 20 });
  const connector = new FakeConnector();
  const connections = new ConnectionsService(
    accounts,
    { resolve: async (runtimeContextId) => ({ directory: `/contexts/${runtimeContextId}` }) },
    [connector],
  );
  const events: HostEvent[] = [];
  const sessionImports = new SessionImportsService(projects, sessions, []);
  const api = new HostApi({ accounts, projects, sessions, sessionImports, execution, runtimes, connections }, (event) => events.push(event));

  const call = async <T>(command: string, params: unknown = {}): Promise<T> => {
    const response = await api.dispatch(command, params);
    if (!response.ok) {
      throw new Error(`${response.error.code}: ${response.error.message}`);
    }
    return response.value as T;
  };

  const project = await call<{ id: string }>("projects.create", { path: "/tmp/demo" });
  const session = await call<{ id: string }>("sessions.create", { projectId: project.id });
  const account = await call<{ id: string }>("accounts.register", {
    providerId: "fake",
    providerAccountId: "user-1",
    credential: { id: "cred-1", providerId: "fake", method: "token" },
    runtimeContextId: "ctx-1",
  });
  return { api, call, events, accounts, connector, project, session, account, hung, execution, projects, sessions };
}

test("removal waits for a concurrent start, rejects active sessions, then preserves the settled audit", { timeout: 3000 }, async () => {
  const { api, call, events, project, session, account } = await setup();
  const other = await call<{ id: string }>("sessions.create", { projectId: project.id });
  const params = { projectId: project.id, sessionId: session.id, providerId: "fake", runtimeId: "blocking-runtime",
    accountId: account.id, prompt: "wait", permissionMode: "full_access" };
  const starting = call<{ run: { id: string } }>("runs.start", params);
  const removal = api.dispatch("sessions.remove", { sessionId: session.id });
  const [started, busy] = await Promise.all([starting, removal]);
  assert.equal(!busy.ok && busy.error.code, "session_busy");
  assert.equal((await call<{ id: string }>("sessions.get", { sessionId: session.id })).id, session.id);
  await call("runs.cancel", { runId: started.run.id });
  await waitFor(events, (event) => event.type === "run.finished");
  await call("sessions.remove", { sessionId: session.id });
  assert.deepEqual((await call<Array<{ id: string }>>("sessions.list")).map((entry) => entry.id), [other.id]);
  const missing = await api.dispatch("sessions.get", { sessionId: session.id });
  assert.equal(!missing.ok && missing.error.code, "session_not_found");
  assert.ok(events.some((event) => event.type === "sessions.removed" && event.sessionId === session.id));
  assert.ok((await call<unknown[]>("runs.journal", { runId: started.run.id })).length > 0);
  const anotherStart = await api.dispatch("runs.start", params);
  assert.equal(!anotherStart.ok && anotherStart.error.code, "session_not_found");
});

test("a start queued after removal cannot resurrect the deleted session", async () => {
  const { api, call, project, session, account } = await setup();
  const removal = call("sessions.remove", { sessionId: session.id });
  const starting = api.dispatch("runs.start", { projectId: project.id, sessionId: session.id, providerId: "fake",
    runtimeId: "blocking-runtime", accountId: account.id, prompt: "wait", permissionMode: "full_access" });
  await removal;
  const result = await starting;
  assert.equal(!result.ok && result.error.code, "session_not_found");
  assert.deepEqual(await call("runs.list", { sessionId: session.id }), []);
  assert.deepEqual(await call("runs.active"), []);
});

function waitFor(events: HostEvent[], predicate: (event: HostEvent) => boolean): Promise<HostEvent> {
  return new Promise((resolve) => {
    const poll = () => {
      const match = events.find(predicate);
      if (match !== undefined) resolve(match);
      else setTimeout(poll, 1);
    };
    poll();
  });
}

test("account views never include credential references or runtime contexts", async () => {
  const { call } = await setup();
  const [account] = await call<Array<Record<string, unknown>>>("accounts.list");
  assert.ok(account);
  assert.equal("credential" in account, false);
  assert.equal("runtimeContextId" in account, false);
  assert.equal(account["selected"], false);
  assert.equal(account["activeAttempts"], 0);
});

test("errors carry stable codes and structured details", async () => {
  const { api } = await setup();
  const duplicate = await api.dispatch("accounts.register", {
    providerId: "fake",
    providerAccountId: "user-1",
    credential: { id: "cred-2", providerId: "fake", method: "token" },
    runtimeContextId: "ctx-2",
  });
  assert.equal(duplicate.ok, false);
  assert.equal(!duplicate.ok && duplicate.error.code, "duplicate_account");
  assert.deepEqual(!duplicate.ok && duplicate.error.details, { providerId: "fake", providerAccountId: "user-1" });

  const invalid = await api.dispatch("projects.create", { path: "" });
  assert.equal(!invalid.ok && invalid.error.code, "invalid_input");

  const extra = await api.dispatch("projects.list", { unexpected: true });
  assert.equal(!extra.ok && extra.error.code, "invalid_input");

  const unknown: CommandResponse = await api.dispatch("projects.drop", {});
  assert.equal(!unknown.ok && unknown.error.code, "unknown_command");

  const missing = await api.dispatch("sessions.get", { sessionId: "nope" });
  assert.equal(!missing.ok && missing.error.code, "session_not_found");
});

test("runtimes report adapter permission mappings", async () => {
  const { call, account } = await setup();
  const runtimes = await call<Array<{ runtimeId: string; permissionMappings: Record<string, string> }>>("runtimes.list");
  assert.deepEqual(runtimes.map((runtime) => runtime.runtimeId), ["approval-runtime", "blocking-runtime", "hung-runtime"]);
  assert.equal(runtimes[0]?.permissionMappings["read_only"], "native read_only");
  const capabilities = await call<{ approvals: boolean }>("runtimes.capabilities", { runtimeId: "approval-runtime", accountId: account.id });
  assert.equal(capabilities.approvals, true);
});

test("model catalog combines accounts and reports partial discovery failures", async () => {
  const { call, account, project } = await setup();
  const second = await call<{ id: string }>("accounts.register", {
    providerId: "fake",
    providerAccountId: "user-2",
    credential: { id: "cred-2", providerId: "fake", method: "token" },
    runtimeContextId: "ctx-2",
  });
  const failed = await call<{ id: string }>("accounts.register", {
    providerId: "fake",
    providerAccountId: "user-3",
    credential: { id: "catalog-fail", providerId: "fake", method: "token" },
    runtimeContextId: "ctx-3",
  });

  const catalog = await call<{
    models: Array<{ id: string; accountIds: string[]; runtimeId: string }>;
    failures: Array<{ accountId: string }>;
  }>("models.list", { projectId: project.id });
  assert.deepEqual(catalog.models.map((model) => model.id), ["fake-model"]);
  assert.deepEqual(catalog.models[0]?.accountIds.sort(), [account.id, second.id].sort());
  assert.equal(catalog.models[0]?.runtimeId, "approval-runtime");
  assert.deepEqual(catalog.failures, [{ providerName: "Fake", accountId: failed.id }]);
});

test("a run streams indexed events, parks approvals for any client, and finishes", async () => {
  const { call, events, project, session, account } = await setup();
  const started = await call<{ run: { id: string } }>("runs.start", {
    sessionId: session.id,
    projectId: project.id,
    providerId: "fake",
    runtimeId: "approval-runtime",
    accountId: account.id,
    prompt: "do it",
    permissionMode: "ask",
  });
  const runId = started.run.id;
  // `run.started` precedes every event of the run, so late subscribers can rely on it.
  const startedIndex = events.findIndex((event) => event.type === "run.started");
  const firstRunEvent = events.findIndex((event) => event.type === "run.event");
  assert.ok(startedIndex !== -1 && (firstRunEvent === -1 || startedIndex < firstRunEvent));

  const approvalEvent = await waitFor(events, (event) => event.type === "run.event" && event.event.type === "approval_request");
  assert.equal(approvalEvent.type === "run.event" && approvalEvent.index, 1);

  // A client that connects now sees the snapshot including the pending approval.
  const [active] = await call<Array<{ events: unknown[]; pendingApprovals: Array<{ id: string }> }>>("runs.active");
  assert.equal(active?.events.length, 2);
  const approvalId = active?.pendingApprovals[0]?.id;
  assert.ok(approvalId);

  const stale = await (async () => {
    try {
      await call("runs.respondToApproval", { runId, approvalId: "other", decision: "allow" });
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  })();
  assert.match(stale ?? "", /^approval_not_found/);

  await call("runs.respondToApproval", { runId, approvalId, decision: "allow" });
  const finished = await waitFor(events, (event) => event.type === "run.finished");
  assert.equal(finished.type === "run.finished" && finished.run.status, "completed");
  assert.ok(events.some((event) => event.type === "run.approval_resolved"));

  const indices = events.flatMap((event) => event.type === "run.event" ? [event.index] : []);
  assert.deepEqual(indices, indices.map((_, index) => index));

  assert.deepEqual(await call("runs.active"), []);
  const runs = await call<Array<{ id: string; attempts: Array<{ runtimeId: string }> }>>("runs.list", { sessionId: session.id });
  assert.equal(runs[0]?.attempts[0]?.runtimeId, "approval-runtime");
  const journal = await call<Array<{ type: string }>>("runs.journal", { runId });
  assert.equal(journal.at(-1)?.type, "run_status");
});

test("starting on a busy project returns project_busy with the owning attempt", async () => {
  const { api, call, events, project, session, account } = await setup();
  const params = {
    sessionId: session.id,
    projectId: project.id,
    providerId: "fake",
    runtimeId: "blocking-runtime",
    accountId: account.id,
    prompt: "wait",
    permissionMode: "full_access",
  };
  const started = await call<{ run: { id: string; attemptIds: string[] } }>("runs.start", params);
  await waitFor(events, (event) => event.type === "run.event");

  const busy = await api.dispatch("runs.start", params);
  assert.equal(!busy.ok && busy.error.code, "project_busy");
  assert.equal(!busy.ok && busy.error.details?.["attemptId"], started.run.attemptIds[0]);

  // Cancellation is idempotent and the run reaches `interrupted`.
  await call("runs.cancel", { runId: started.run.id });
  await call("runs.cancel", { runId: started.run.id });
  const finished = await waitFor(events, (event) => event.type === "run.finished");
  assert.equal(finished.type === "run.finished" && finished.run.status, "interrupted");
  assert.equal(events.filter((event) => event.type === "run.cancel_requested").length, 1);
});

test("pending questions survive client snapshots and answer through the host in automatic permission mode", { timeout: 3000 }, async () => {
  const { api, call, events, project, session, account } = await setup(true);
  const { run } = await call<{ run: { id: string } }>("runs.start", { sessionId: session.id, projectId: project.id, providerId: "fake", runtimeId: "question-runtime",
    accountId: account.id, prompt: "ask", permissionMode: "approve_for_me" });
  await waitFor(events, (event) => event.type === "run.event" && event.event.type === "question_request");
  const [active] = await call<Array<{ pendingQuestions: Array<{ id: string; questions: unknown[] }> }>>("runs.active");
  assert.equal(active?.pendingQuestions.length, 1);
  const requestId = active!.pendingQuestions[0]!.id;
  const invalid = await api.dispatch("runs.respondToQuestions", { runId: run.id, requestId, response: { answers: { wrong: ["Short"] } } });
  assert.equal(!invalid.ok && invalid.error.code, "invalid_input");
  await call("runs.respondToQuestions", { runId: run.id, requestId, response: { answers: { format: ["My own format"] } } });
  const finished = await waitFor(events, (event) => event.type === "run.finished");
  assert.equal(finished.type === "run.finished" && finished.run.status, "completed");
  assert.deepEqual(await call("runs.active"), []);
  const journal = await call<Array<{ type: string }>>("runs.journal", { runId: run.id });
  assert.equal(journal.filter((entry) => entry.type === "question_request").length, 1);
  assert.equal(journal.filter((entry) => entry.type === "question_resolved").length, 1);
  assert.ok(events.some((event) => event.type === "run.event" && event.event.type === "question_resolved"));
});

test("cancelling a run settles pending questions and releases the project writer", { timeout: 3000 }, async () => {
  const { call, events, project, session, account } = await setup(true);
  const { run } = await call<{ run: { id: string } }>("runs.start", { sessionId: session.id, projectId: project.id, providerId: "fake", runtimeId: "question-runtime",
    accountId: account.id, prompt: "ask", permissionMode: "full_access" });
  await waitFor(events, (event) => event.type === "run.event" && event.event.type === "question_request");
  await call("runs.cancel", { runId: run.id });
  const finished = await waitFor(events, (event) => event.type === "run.finished");
  assert.equal(finished.type === "run.finished" && finished.run.status, "interrupted");
  assert.deepEqual(await call("runs.active"), []);
  const [saved] = await call<Array<{ activeWriterAttemptId?: string }>>("projects.list");
  assert.equal(saved?.activeWriterAttemptId, undefined);
});

test("shutdown cancels active runs and waits for terminal states", async () => {
  const { api, call, events, project, session, account } = await setup();
  await call("runs.start", {
    sessionId: session.id,
    projectId: project.id,
    providerId: "fake",
    runtimeId: "blocking-runtime",
    accountId: account.id,
    prompt: "wait",
    permissionMode: "full_access",
  });
  await waitFor(events, (event) => event.type === "run.event");
  assert.equal(await api.shutdown(1_000), 0);
  assert.ok(events.some((event) => event.type === "run.finished"));
});

test("an automatic account choice reports fallback from the selected account", async () => {
  const { call, events, accounts, project, session, account } = await setup();
  const second = await call<{ id: string }>("accounts.register", {
    providerId: "fake",
    providerAccountId: "user-2",
    credential: { id: "cred-2", providerId: "fake", method: "token" },
    runtimeContextId: "ctx-2",
  });
  await call("accounts.select", { providerId: "fake", accountId: account.id });
  await accounts.updateAvailability(account.id, { status: "unavailable" });
  await accounts.updateAvailability(second.id, { status: "available" });

  const started = await call<{ run: { id: string; accountId: string }; fallbackFromAccountId?: string }>("runs.start", {
    sessionId: session.id,
    projectId: project.id,
    providerId: "fake",
    runtimeId: "blocking-runtime",
    prompt: "wait",
    permissionMode: "full_access",
  });
  assert.equal(started.run.accountId, second.id);
  assert.equal(started.fallbackFromAccountId, account.id);
  await waitFor(events, (event) => event.type === "run.event");
  const listed = await call<Array<{ id: string; activeAttempts: number }>>("accounts.list");
  assert.equal(listed.find((entry) => entry.id === second.id)?.activeAttempts, 1);
  await call("runs.cancel", { runId: started.run.id });
  await waitFor(events, (event) => event.type === "run.finished");
});

test("connecting an account signs in, registers it as available, and selects it", async () => {
  const { call, events, connector } = await setup();
  const providers = await call<Array<{ providerId: string; displayName: string }>>("auth.providers");
  assert.deepEqual(providers, [{ providerId: "fake", displayName: "Fake" }]);

  const started = await call<{ connectId: string; status: string }>("auth.connect", { providerId: "fake" });
  assert.equal(started.status, "waiting");
  const prompted = await waitFor(events, (event) => event.type === "auth.updated" && event.connect.needsCode);
  assert.equal(prompted.type === "auth.updated" && prompted.connect.url, "https://example.test/sign-in");
  assert.equal((await call<unknown[]>("auth.active")).length, 1);

  await call("auth.submitCode", { connectId: started.connectId, code: "user-9" });
  const done = await waitFor(events, (event) => event.type === "auth.updated" && event.connect.status === "completed");
  assert.equal(done.type === "auth.updated" && done.connect.reconnected, false);
  assert.ok(events.some((event) => event.type === "accounts.changed"));
  assert.equal(connector.cancelled, 1, "provider process is released after completion");

  const accounts = await call<Array<{ identity: { providerAccountId: string }; availability: string; selected: boolean }>>("accounts.list");
  const connected = accounts.find((entry) => entry.identity.providerAccountId === "user-9");
  assert.equal(connected?.availability, "available");
  assert.equal(connected?.selected, true);
  assert.deepEqual(await call("auth.active"), []);
});

test("diagnostic commands validate inputs and return unsupported checks without account mutation", async () => {
  const { api, call, accounts, account, connector } = await setup();
  const before = await accounts.get(account.id);
  const result = await call<{ status: string; authentication: string }>("auth.diagnose", { providerId: "fake", accountId: account.id });
  assert.equal(result.status, "failed"); assert.equal(result.authentication, "not_checked");
  assert.deepEqual(await accounts.get(account.id), before);
  assert.equal(connector.contexts.length, 0);
  const invalid = await api.dispatch("auth.diagnose", { providerId: "fake", directory: "/arbitrary" });
  assert.equal(invalid.ok, false);
  const missing = await api.dispatch("auth.diagnose", { providerId: "unknown" });
  assert.equal(!missing.ok && missing.error.code, "connector_not_found");
});

test("reconnecting the same identity re-authenticates onto a fresh context", async () => {
  const { call, events, accounts, connector } = await setup();
  const first = await call<{ connectId: string }>("auth.connect", { providerId: "fake" });
  await waitFor(events, (event) => event.type === "auth.updated" && event.connect.needsCode);
  await call("auth.submitCode", { connectId: first.connectId, code: "user-9" });
  const done = await waitFor(events, (event) => event.type === "auth.updated" && event.connect.status === "completed");
  const accountId = done.type === "auth.updated" ? done.connect.accountId ?? "" : "";
  const before = await accounts.get(accountId);
  events.length = 0;

  const again = await call<{ connectId: string }>("auth.connect", { providerId: "fake", accountId });
  await waitFor(events, (event) => event.type === "auth.updated" && event.connect.needsCode);
  await call("auth.submitCode", { connectId: again.connectId, code: "user-9" });
  const second = await waitFor(events, (event) => event.type === "auth.updated" && event.connect.status === "completed");
  assert.equal(second.type === "auth.updated" && second.connect.reconnected, true);
  assert.equal(second.type === "auth.updated" && second.connect.accountId, accountId);

  const after = await accounts.get(accountId);
  assert.notEqual(after.runtimeContextId, before.runtimeContextId);
  assert.equal(after.credential.method, NATIVE_LOGIN_METHOD);
  assert.equal(after.availability, "available");
  assert.equal(connector.contexts.length, 2);
  assert.equal((await accounts.list("fake")).filter((entry) => entry.identity.providerAccountId === "user-9").length, 1);
});

test("cancelling a sign-in reports cancelled and stops the provider", async () => {
  const { api, call, events, connector } = await setup();
  const started = await call<{ connectId: string }>("auth.connect", { providerId: "fake" });
  await call("auth.cancel", { connectId: started.connectId });
  const cancelled = await waitFor(events, (event) => event.type === "auth.updated" && event.connect.status === "cancelled");
  assert.ok(cancelled);
  assert.ok(connector.cancelled >= 1);
  const missing = await api.dispatch("auth.submitCode", { connectId: started.connectId, code: "x" });
  assert.equal(!missing.ok && missing.error.code, "connect_not_found");
  const unknown = await api.dispatch("auth.connect", { providerId: "nope" });
  assert.equal(!unknown.ok && unknown.error.code, "connector_not_found");
});

test("a project is the only folder identity exposed by the host", async () => {
  const { api, call, events, project, session } = await setup();
  const projects = await call<Array<{ id: string; path: string }>>("projects.list");
  assert.deepEqual(projects.map((item) => item.id), [project.id]);
  assert.equal(projects[0]?.path, "/tmp/demo");
  const savedSession = await call<{ projectId: string }>("sessions.get", { sessionId: session.id });
  assert.equal(savedSession.projectId, project.id);
  assert.equal("workspaceId" in savedSession, false);
  assert.ok(events.some((event) => event.type === "projects.changed"));
  const obsolete = await api.dispatch("workspaces.list", {});
  assert.equal(!obsolete.ok && obsolete.error.code, "unknown_command");
  const missing = await api.dispatch("sessions.create", { projectId: "no-such-project" });
  assert.equal(!missing.ok && missing.error.code, "project_not_found");
  const oldInput = await api.dispatch("sessions.create", { projectId: project.id, workspaceId: "obsolete" });
  assert.equal(!oldInput.ok && oldInput.error.code, "invalid_input");
});

test("confirmed force deletion stops a hung provider, settles its audit, and rejects late output", { timeout: 3000 }, async () => {
  const { api, call, events, project, session, account, hung, execution, projects } = await setup();
  const { run } = await call<{ run: { id: string } }>("runs.start", { sessionId: session.id, projectId: project.id, providerId: "fake", runtimeId: "hung-runtime",
    accountId: account.id, prompt: "wait", permissionMode: "full_access" });
  await waitFor(events, (event) => event.type === "run.event");
  const ordinary = await api.dispatch("sessions.remove", { sessionId: session.id });
  assert.equal(!ordinary.ok && ordinary.error.code, "session_busy");
  assert.equal(hung.stopped, false, "unconfirmed deletion must not stop the run");
  await call("sessions.remove", { sessionId: session.id, force: true });
  assert.equal(hung.stopped, true);
  assert.deepEqual(await call("runs.active"), []);
  assert.equal((await execution.getRun(run.id)).status, "interrupted");
  assert.equal((await projects.getProject(project.id)).activeWriterAttemptId, undefined);
  hung.output.push({ type: "message_delta", text: "late output must not be saved" });
  hung.output.push({ type: "completed", result: "late completion" }); hung.output.complete();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await execution.getRun(run.id)).status, "interrupted");
  assert.doesNotMatch(JSON.stringify(await execution.listJournal(run.id)), /late output|late completion/);
  const missing = await api.dispatch("sessions.get", { sessionId: session.id });
  assert.equal(!missing.ok && missing.error.code, "session_not_found");
  assert.ok(events.some((event) => event.type === "sessions.removed" && event.sessionId === session.id));
});

test("initialization is idempotent and cannot recover a run owned by this live host", async () => {
  const { call, events, session, project, account, execution } = await setup();
  const { run } = await call<{ run: { id: string } }>("runs.start", { sessionId: session.id, projectId: project.id, providerId: "fake", runtimeId: "blocking-runtime", accountId: account.id, prompt: "wait", permissionMode: "full_access" });
  await waitFor(events, (event) => event.type === "run.event");
  await execution.initialize();
  assert.equal((await execution.getRun(run.id)).status, "running");
  await call("sessions.remove", { sessionId: session.id, force: true });
});

test("shutdown rejects queued starts so a closing app cannot create a new untracked run", async () => {
  const { api, project, session, account, call } = await setup();
  const starting = api.dispatch("runs.start", { sessionId: session.id, projectId: project.id, providerId: "fake", runtimeId: "blocking-runtime", accountId: account.id, prompt: "wait", permissionMode: "full_access" });
  assert.equal(await api.shutdown(1000), 0);
  const result = await starting;
  assert.equal(!result.ok && result.error.code, "host_unavailable");
  assert.deepEqual(await call("runs.active"), []);
});
