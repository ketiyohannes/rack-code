import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryAccountStore } from "../accounts/in-memory-store.js";
import { AccountsService } from "../accounts/service.js";
import { InMemoryExecutionStore } from "./in-memory-store.js";
import { ExecutionService } from "./service.js";
import { RuntimeRegistry } from "./runtime-registry.js";
import type {
  RuntimeAccountContext,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeRunInput,
} from "./types.js";
import { InMemoryProjectStore } from "../projects/in-memory-store.js";
import { ProjectsService } from "../projects/service.js";
import { InMemorySessionStore } from "../sessions/in-memory-store.js";
import { SessionsService } from "../sessions/service.js";
import type { AttachmentStore, SessionAttachment } from "../sessions/attachments.js";

class FakeRuntime implements RuntimeAdapter {
  readonly runtimeId: string = "fake-runtime";
  readonly started: RuntimeRunInput[] = [];
  readonly resumed: RuntimeRunInput[] = [];

  async capabilities(_account: RuntimeAccountContext): Promise<RuntimeCapabilities> {
    return {
      resume: true,
      fork: false,
      approvals: true,
      quotaReporting: true,
      browserTools: false,
      computerUse: false,
    };
  }

  async *startRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    this.started.push(input);
    yield { type: "native_session", nativeSessionId: "fake-native-1" };
    yield { type: "tool_request", tool: "write_file", input: { path: "a.txt" } };
    const decision = await input.requestApproval({
      tool: "write_file",
      input: { path: "a.txt" },
      reason: "The fake runtime needs to write a file.",
    });
    yield { type: "tool_result", output: { decision } };
    yield { type: "message_delta", text: "done" };
    yield { type: "completed", result: "done" };
  }

  async *resumeRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    this.resumed.push(input);
    yield { type: "native_session", nativeSessionId: "fake-native-1" };
    yield { type: "message_delta", text: "continued" };
    yield { type: "completed", result: "continued" };
  }

  describePermissionMode(mode: string): string {
    return `fake mapping for ${mode}`;
  }

  async cancel(_input: Pick<RuntimeRunInput, "attemptId" | "signal">): Promise<void> {
    // The fake runtime has no external process to interrupt.
  }
}

class BlockingRuntime extends FakeRuntime {
  override readonly runtimeId = "blocking-runtime";

  override async *startRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    yield { type: "native_session", nativeSessionId: "blocking-native" };
    if (!input.signal.aborted) {
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    }
    yield { type: "interrupted" };
  }
}

class NoTerminalRuntime extends FakeRuntime {
  override readonly runtimeId = "no-terminal-runtime";

  override async *startRun(_input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    yield { type: "message_delta", text: "possibly completed" };
  }
}

function setup(attachments?: AttachmentStore) {
  const now = () => new Date("2026-10-12T00:00:00.000Z");
  const accounts = new AccountsService(new InMemoryAccountStore(), { now });
  const projects = new ProjectsService(new InMemoryProjectStore(), { now });
  const sessions = new SessionsService(new InMemorySessionStore(), { now, ...(attachments === undefined ? {} : { attachments }) });
  const executions = new InMemoryExecutionStore();
  const runtimes = new RuntimeRegistry();
  const runtime = new FakeRuntime();
  runtimes.register(runtime);
  const service = new ExecutionService(executions, accounts, sessions, projects, runtimes, { now });
  return { accounts, projects, sessions, executions, runtime, service };
}

async function createFixture(attachments?: AttachmentStore) {
  const fixture = setup(attachments);
  const account = await fixture.accounts.register({
    id: "account-1",
    providerId: "fake",
    identity: { providerAccountId: "provider-account-1" },
    credential: { id: "credential-1", providerId: "fake", method: "test" },
    runtimeContextId: "runtime-context-1",
    availability: "available",
  });
  const project = await fixture.projects.createProject({
    id: "project-1",
    path: "/tmp/example",
  });
  const session = await fixture.sessions.create({
    id: "session-1",
    projectId: project.id,
  });
  return { ...fixture, account, project, session };
}

test("attachment-only turns retain descriptors and deliver quoted file paths on start and resume", async () => {
  const file: SessionAttachment = { id: "file-1", name: "notes\nimage.png", path: "/app/attachments/image.png", size: 32 };
  const storage: AttachmentStore = {
    importFile: async () => file, remove: async () => {},
    get: async (sessionId, id) => {
      if (sessionId !== "session-1" || id !== file.id) throw new Error("Attachment not found.");
      return file;
    },
  };
  const fixture = await createFixture(storage);
  const input = { sessionId: fixture.session.id, projectId: fixture.project.id, providerId: "fake",
    runtimeId: fixture.runtime.runtimeId, prompt: "", attachmentIds: [file.id], permissionMode: "read_only" as const };
  const first = await fixture.service.start(input);
  const completed = await first.completed;
  assert.equal(completed.prompt, "");
  assert.deepEqual(completed.attachments, [file]);
  assert.ok(fixture.runtime.started[0]?.prompt.includes(JSON.stringify(file.path)));
  assert.ok(fixture.runtime.started[0]?.prompt.includes(JSON.stringify(file.name)));
  const history = await fixture.sessions.get(fixture.session.id);
  assert.ok(history.messages[0]?.content.includes(JSON.stringify(file.path)));
  const second = await fixture.service.start({ ...input, prompt: "Review again" });
  await second.completed;
  assert.ok(fixture.runtime.resumed[0]?.prompt.includes(JSON.stringify(file.path)));
  const count = (await fixture.service.listRuns(fixture.session.id)).length;
  await assert.rejects(fixture.service.start({ ...input, attachmentIds: ["another-session-file"] }), /Attachment not found/);
  await assert.rejects(fixture.service.start({ ...input, attachmentIds: [] }), /prompt or attachment/);
  assert.equal((await fixture.service.listRuns(fixture.session.id)).length, count);
});

test("executes a run end to end, persists transcript and journal, and releases the project", async () => {
  const fixture = await createFixture();
  const handle = await fixture.service.start({
    sessionId: fixture.session.id,
    projectId: fixture.project.id,
    providerId: "fake",
    runtimeId: fixture.runtime.runtimeId,
    prompt: "create a file",
    permissionMode: "ask",
  });

  const iterator = handle.events[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value?.type, "native_session");
  const toolRequest = await iterator.next();
  assert.equal(toolRequest.value?.type, "tool_request");
  const approval = await iterator.next();
  assert.equal(approval.value?.type, "approval_request");
  if (approval.value?.type !== "approval_request") {
    throw new Error("Expected approval request.");
  }
  handle.respondToApproval(approval.value.request.id, "allow");

  const events: RuntimeEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    events.push(next.value);
  }
  const run = await handle.completed;

  assert.equal(run.status, "completed");
  assert.equal(run.result, "done");
  assert.deepEqual(events.map((event) => event.type), ["tool_result", "message_delta", "completed"]);
  assert.equal((await fixture.sessions.get(fixture.session.id)).messages.length, 2);
  assert.equal((await fixture.projects.getProject(fixture.project.id)).activeWriterAttemptId, undefined);
  const journal = await fixture.executions.listJournal(run.id);
  assert.ok(journal.some((entry) => entry.type === "approval_request"));
  assert.equal(fixture.runtime.started.length, 1);
});

test("uses the application continuation when the same session resumes on the runtime", async () => {
  const fixture = await createFixture();
  const first = await fixture.service.start({
    sessionId: fixture.session.id,
    projectId: fixture.project.id,
    providerId: "fake",
    runtimeId: fixture.runtime.runtimeId,
    prompt: "first",
    permissionMode: "ask",
  });
  const firstIterator = first.events[Symbol.asyncIterator]();
  for (;;) {
    const next = await firstIterator.next();
    if (next.done) break;
    if (next.value.type === "approval_request") {
      first.respondToApproval(next.value.request.id, "allow");
    }
  }
  await first.completed;

  const second = await fixture.service.start({
    sessionId: fixture.session.id,
    projectId: fixture.project.id,
    providerId: "fake",
    runtimeId: fixture.runtime.runtimeId,
    prompt: "continue",
    permissionMode: "ask",
  });
  const secondIterator = second.events[Symbol.asyncIterator]();
  while (!(await secondIterator.next()).done) {
    // The resumed fake runtime has no approval request.
  }
  await second.completed;

  assert.equal(fixture.runtime.resumed.length, 1);
  assert.equal(fixture.runtime.resumed[0]?.continuation?.nativeSessionId, "fake-native-1");
});

test("does not resume a native thread from another account's runtime context", async () => {
  const fixture = await createFixture();
  await fixture.accounts.register({
    id: "account-2",
    providerId: "fake",
    identity: { providerAccountId: "provider-account-2" },
    credential: { id: "credential-2", providerId: "fake", method: "test" },
    runtimeContextId: "runtime-context-2",
    availability: "available",
  });
  const runOn = async (accountId: string) => {
    const handle = await fixture.service.start({
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      providerId: "fake",
      accountId,
      runtimeId: fixture.runtime.runtimeId,
      prompt: `run on ${accountId}`,
      permissionMode: "ask",
    });
    const iterator = handle.events[Symbol.asyncIterator]();
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === "approval_request") {
        handle.respondToApproval(next.value.request.id, "allow");
      }
    }
    await handle.completed;
  };

  await runOn("account-1");
  await runOn("account-2");
  // Switching to account-2 must start fresh: account-1's thread lives in a
  // different runtime context and would fail to resume natively.
  assert.equal(fixture.runtime.started.length, 2);
  assert.equal(fixture.runtime.resumed.length, 0);

  await runOn("account-1");
  // Returning to account-1 resumes its own thread, kept alongside account-2's.
  assert.equal(fixture.runtime.resumed.length, 1);
  assert.equal(fixture.runtime.resumed[0]?.account.runtimeContextId, "runtime-context-1");
  assert.deepEqual(
    (await fixture.sessions.get(fixture.session.id)).continuations.map((continuation) => continuation.runtimeContextId),
    ["runtime-context-2", "runtime-context-1"],
  );
});

test("cancellation interrupts the attempt and releases the project", async () => {
  const fixture = await createFixture();
  const blocking = new BlockingRuntime();
  const runtimes = new RuntimeRegistry();
  runtimes.register(blocking);
  const service = new ExecutionService(
    fixture.executions,
    fixture.accounts,
    fixture.sessions,
    fixture.projects,
    runtimes,
  );
  const handle = await service.start({
    sessionId: fixture.session.id,
    projectId: fixture.project.id,
    providerId: "fake",
    runtimeId: blocking.runtimeId,
    prompt: "wait",
    permissionMode: "ask",
  });
  await handle.cancel();
  const run = await handle.completed;

  assert.equal(run.status, "interrupted");
  assert.equal((await fixture.projects.getProject(fixture.project.id)).activeWriterAttemptId, undefined);
});

test("records the eligible fallback account on a new attempt", async () => {
  const fixture = await createFixture();
  await fixture.accounts.register({
    id: "account-2",
    providerId: "fake",
    identity: { providerAccountId: "provider-account-2" },
    credential: { id: "credential-2", providerId: "fake", method: "test" },
    runtimeContextId: "runtime-context-2",
    availability: "available",
  });
  await fixture.accounts.updateAvailability(fixture.account.id, {
    status: "unavailable",
    reason: "limit reached",
  });

  const handle = await fixture.service.start({
    sessionId: fixture.session.id,
    projectId: fixture.project.id,
    providerId: "fake",
    runtimeId: fixture.runtime.runtimeId,
    prompt: "use fallback",
    permissionMode: "read_only",
  });
  const iterator = handle.events[Symbol.asyncIterator]();
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    if (next.value.type === "approval_request") {
      handle.respondToApproval(next.value.request.id, "deny");
    }
  }
  const run = await handle.completed;

  assert.equal(run.accountId, "account-2");
  assert.equal(fixture.runtime.started[0]?.account.accountId, "account-2");
});

test("marks a provider stream without a terminal event as unknown", async () => {
  const fixture = await createFixture();
  const runtime = new NoTerminalRuntime();
  const runtimes = new RuntimeRegistry();
  runtimes.register(runtime);
  const service = new ExecutionService(
    fixture.executions,
    fixture.accounts,
    fixture.sessions,
    fixture.projects,
    runtimes,
  );
  const handle = await service.start({
    sessionId: fixture.session.id,
    projectId: fixture.project.id,
    providerId: "fake",
    runtimeId: runtime.runtimeId,
    prompt: "disconnect",
    permissionMode: "ask",
  });
  const iterator = handle.events[Symbol.asyncIterator]();
  while (!(await iterator.next()).done) {
    // Drain the stream before inspecting its durable terminal status.
  }
  assert.equal((await handle.completed).status, "unknown");
});

test("rejects a run in another project before recording work or calling a runtime", async () => {
  const fixture = await createFixture();
  const other = await fixture.projects.createProject({ path: "/tmp/other" });
  await assert.rejects(fixture.service.start({
    sessionId: fixture.session.id, projectId: other.id,
    providerId: "fake", runtimeId: fixture.runtime.runtimeId,
    prompt: "wrong folder", permissionMode: "read_only",
  }), /project must match its session/);
  assert.deepEqual(await fixture.service.listRuns(fixture.session.id), []);
  assert.deepEqual(fixture.runtime.started, []);
  assert.equal((await fixture.projects.getProject(other.id)).activeWriterAttemptId, undefined);
});

test("an imported conversation starts fresh with visible context and preserves the user's prompt", async () => {
  const fixture = await createFixture();
  const session = await fixture.sessions.importSnapshot(fixture.project.id, {
    session: { sourceId: "external", providerName: "External", nativeSessionId: "outside-id", projectPath: fixture.project.path,
      title: "Imported history", createdAt: fixture.session.createdAt, updatedAt: fixture.session.updatedAt },
    messages: [{ role: "user", content: "Earlier request" }, { role: "assistant", content: "Earlier answer" },
      { role: "tool", content: "Do not replay this tool action" }],
  });
  const handle = await fixture.service.start({ sessionId: session.id, projectId: fixture.project.id,
    providerId: "fake", runtimeId: fixture.runtime.runtimeId, prompt: "Continue now", permissionMode: "read_only" });
  await handle.completed;
  assert.equal(fixture.runtime.resumed.length, 0);
  assert.equal(fixture.runtime.started.length, 1);
  assert.match(fixture.runtime.started[0]?.prompt ?? "", /Earlier request/);
  assert.match(fixture.runtime.started[0]?.prompt ?? "", /Earlier answer/);
  assert.doesNotMatch(fixture.runtime.started[0]?.prompt ?? "", /Do not replay this tool action/);
  assert.equal((await fixture.service.getRun(handle.runId)).prompt, "Continue now");
  assert.equal(fixture.runtime.started[0]?.permissionMode, "read_only");
  const resumed = await fixture.service.start({ sessionId: session.id, projectId: fixture.project.id,
    providerId: "fake", runtimeId: fixture.runtime.runtimeId, prompt: "Again", permissionMode: "read_only" });
  await resumed.completed;
  assert.equal(fixture.runtime.resumed[0]?.prompt, "Again");
});

test("records the requested reasoning effort and speed and passes them to the runtime", async () => {
  const fixture = await createFixture();
  const handle = await fixture.service.start({
    sessionId: fixture.session.id,
    projectId: fixture.project.id,
    providerId: "fake",
    runtimeId: fixture.runtime.runtimeId,
    prompt: "think hard",
    model: "fake-model",
    reasoningEffort: "xhigh",
    speed: "fast",
    permissionMode: "full_access",
  });
  for await (const event of handle.events) {
    if (event.type === "approval_request") handle.respondToApproval(event.request.id, "allow");
  }
  const run = await handle.completed;
  assert.equal(run.reasoningEffort, "xhigh");
  assert.equal(fixture.runtime.started[0]?.reasoningEffort, "xhigh");
  assert.equal(run.speed, "fast");
  assert.equal(fixture.runtime.started[0]?.speed, "fast");
});

test("a failed terminal save closes events and relinquishes live ownership instead of hanging", async () => {
  const fixture = await createFixture();
  class FailedFinalStore extends InMemoryExecutionStore {
    override async saveRun(run: import("./types.js").RunRecord): Promise<void> {
      if (run.status === "completed") throw new Error("Final write failed");
      await super.saveRun(run);
    }
  }
  const runtimes = new RuntimeRegistry(); runtimes.register(fixture.runtime);
  const execution = new ExecutionService(new FailedFinalStore(), fixture.accounts, fixture.sessions, fixture.projects, runtimes);
  const handle = await execution.start({ sessionId: fixture.session.id, projectId: fixture.project.id, providerId: "fake", runtimeId: fixture.runtime.runtimeId, prompt: "work", permissionMode: "read_only" });
  const drained = (async () => { for await (const _event of handle.events) { /* Consume until the failure closes the queue. */ } })();
  await assert.rejects(handle.completed, /Final write failed/);
  await drained;
  assert.equal(execution.isActive(handle.runId), false);
  assert.equal((await fixture.projects.getProject(fixture.project.id)).activeWriterAttemptId, undefined);
});
