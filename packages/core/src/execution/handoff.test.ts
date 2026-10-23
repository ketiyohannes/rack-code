import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryAccountStore } from "../accounts/in-memory-store.js";
import { AccountsService } from "../accounts/service.js";
import { InMemoryProjectStore } from "../projects/in-memory-store.js";
import { ProjectsService } from "../projects/service.js";
import { InMemorySessionStore } from "../sessions/in-memory-store.js";
import { SessionsService } from "../sessions/service.js";
import type { SessionMessage } from "../sessions/types.js";
import { renderHandoffContext, summarizeActivity } from "./handoff.js";
import { InMemoryExecutionStore } from "./in-memory-store.js";
import { RuntimeRegistry } from "./runtime-registry.js";
import { ExecutionService } from "./service.js";
import type { JournalEntry, RuntimeAdapter, RuntimeEvent, RuntimeRunInput } from "./types.js";

/**
 * Scripted runtime: each turn edits one file and replies with its runtime ID.
 * `missingThreads` makes resume of those native IDs fail the way Codex does
 * for a thread without a rollout.
 */
class ScriptedRuntime implements RuntimeAdapter {
  readonly started: RuntimeRunInput[] = [];
  readonly resumed: RuntimeRunInput[] = [];
  readonly missingThreads = new Set<string>();
  private threads = 0;
  constructor(readonly runtimeId: string, readonly providerId: string) {}
  async capabilities() { return { resume: true, fork: false, approvals: true, quotaReporting: false, browserTools: false, computerUse: false }; }
  describePermissionMode(): string { return "scripted"; }
  async cancel(): Promise<void> {}
  startRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    this.started.push(input);
    return this.turn(`${this.runtimeId}-thread-${++this.threads}`);
  }
  async *resumeRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    this.resumed.push(input);
    const id = input.continuation!.nativeSessionId;
    if (this.missingThreads.has(id)) { yield { type: "failed", error: `no rollout found for thread id ${id}`, reason: "continuation_unavailable" }; return; }
    yield* this.turn(id);
  }
  private async *turn(threadId: string): AsyncIterable<RuntimeEvent> {
    yield { type: "native_session", nativeSessionId: threadId };
    yield { type: "tool_request", tool: "fileChange", toolCallId: `${threadId}-edit`, input: { changes: [{ path: `src/${this.runtimeId}.ts` }] } };
    yield { type: "tool_result", toolCallId: `${threadId}-edit`, output: {} };
    yield { type: "message_delta", text: `${this.runtimeId} finished` };
    yield { type: "completed", result: `${this.runtimeId} finished` };
  }
}

async function fixture() {
  const now = () => new Date("2026-10-22T00:00:00.000Z");
  const accounts = new AccountsService(new InMemoryAccountStore(), { now });
  const projects = new ProjectsService(new InMemoryProjectStore(), { now });
  const sessions = new SessionsService(new InMemorySessionStore(), { now });
  const store = new InMemoryExecutionStore();
  const registry = new RuntimeRegistry();
  const codex = new ScriptedRuntime("codex", "openai");
  const claude = new ScriptedRuntime("claude", "anthropic");
  registry.register(codex);
  registry.register(claude);
  for (const providerId of ["openai", "anthropic"]) {
    await accounts.register({ id: `${providerId}-account`, providerId, identity: { providerAccountId: providerId },
      credential: { id: `${providerId}-credential`, providerId, method: "test" }, runtimeContextId: `${providerId}-context`, availability: "available" });
  }
  await projects.createProject({ id: "project", path: "/tmp/handoff" });
  const session = await sessions.create({ id: "session", projectId: "project" });
  const service = new ExecutionService(store, accounts, sessions, projects, registry, { now });
  const run = async (runtime: ScriptedRuntime, prompt: string) => {
    const handle = await service.start({ sessionId: session.id, projectId: "project", providerId: runtime.providerId,
      runtimeId: runtime.runtimeId, model: `${runtime.runtimeId}-model`, prompt, permissionMode: "full_access" });
    for await (const _event of handle.events) { /* Drain. */ }
    return handle.completed;
  };
  return { service, sessions, store, codex, claude, run, session };
}

test("a resumed thread receives the other runtime's intervening work, then only new turns", async () => {
  const { codex, claude, run, sessions } = await fixture();
  await run(codex, "Plan the change");
  await run(claude, "Implement it");
  await run(codex, "Review what Claude did");

  assert.equal(codex.resumed.length, 1);
  const handoff = codex.resumed[0]!.prompt;
  assert.match(handoff, /^While you were away, other agents/);
  assert.match(handoff, /Implement it/);
  assert.match(handoff, /"by":"anthropic · claude-model"/);
  assert.match(handoff, /"changedFiles":\["src\/claude\.ts"\]/);
  assert.match(handoff, /changed: src\/claude\.ts/);
  // Codex's own earlier turn is not handed back to it.
  assert.doesNotMatch(handoff, /Plan the change/);
  assert.match(handoff, /Current request:\nReview what Claude did$/);

  // The marker now sits on Codex's latest reply, so an immediate follow-up
  // carries no handoff at all.
  const marker = (await sessions.get("session")).continuations.find((entry) => entry.runtimeId === "codex")?.seenThroughMessageId;
  assert.equal((await sessions.get("session")).messages.at(-1)?.id, marker);
  await run(codex, "Thanks");
  assert.equal(codex.resumed[1]?.prompt, "Thanks");
});

test("a fresh thread receives attributed history instead of an 'imported' label", async () => {
  const { codex, claude, run } = await fixture();
  await run(codex, "First request");
  await run(claude, "Second request");
  const prompt = claude.started[0]!.prompt;
  assert.match(prompt, /^Rack conversation history for this session/);
  assert.doesNotMatch(prompt, /imported/i);
  assert.match(prompt, /"by":"openai · codex-model"/);
  assert.match(prompt, /src\/codex\.ts/);
});

test("legacy continuations without a marker derive their position from recorded attempts", async () => {
  const { codex, claude, run, sessions } = await fixture();
  await run(codex, "Codex turn");
  await run(claude, "Claude turn");
  // Simulate a record saved before markers were maintained.
  const session = await sessions.get("session");
  for (const entry of session.continuations) {
    await sessions.associateContinuation("session", { runtimeId: entry.runtimeId, runtimeContextId: entry.runtimeContextId!, nativeSessionId: entry.nativeSessionId });
  }
  await run(codex, "Codex again");
  assert.match(codex.resumed[0]!.prompt, /Claude turn/);
  assert.doesNotMatch(codex.resumed[0]!.prompt, /Codex turn/);
});

test("an unresumable native thread falls back to a fresh thread with full context in the same run", async () => {
  const { codex, claude, run, sessions, store } = await fixture();
  await run(codex, "Codex turn");
  await run(claude, "Claude turn");
  codex.missingThreads.add("codex-thread-1");
  const result = await run(codex, "Continue");

  assert.equal(result.status, "completed");
  assert.equal(result.attemptIds.length, 1);
  assert.equal(codex.resumed.length, 1);
  assert.equal(codex.started.length, 2);
  // The fresh thread needs the whole conversation, including Codex's own turn.
  assert.match(codex.started[1]!.prompt, /Codex turn/);
  assert.match(codex.started[1]!.prompt, /Claude turn/);
  const continuation = (await sessions.get("session")).continuations.find((entry) => entry.runtimeId === "codex");
  assert.equal(continuation?.nativeSessionId, "codex-thread-2");
  const journal = await store.listJournal(result.id);
  assert.equal(journal.some((entry) => entry.type === "failed"), false, "the recovered failure is not the run's outcome");
  assert.equal(journal.some((entry) => entry.type === "run_status" && (entry.payload as { reason?: string }).reason === "continuation_unavailable"), true);
});

const message = (id: string, role: SessionMessage["role"], content: string): SessionMessage =>
  ({ id, role, content, createdAt: "2026-10-22T00:00:00.000Z" });
const noSources = { run: () => undefined, journal: async () => [] };

test("budgeting keeps whole turns and reports how many were omitted", async () => {
  const messages = [message("1", "user", "a".repeat(500)), message("2", "assistant", "b".repeat(500)), message("3", "user", "newest")];
  const context = (await renderHandoffContext("history", messages, noSources, 700))!;
  assert.match(context, /1 older turn was omitted/);
  assert.doesNotMatch(context, /a{10}/);
  assert.match(context, /b{500}/);
  assert.match(context, /newest/);
});

test("an oversized newest turn is shortened with an explicit notice", async () => {
  const context = (await renderHandoffContext("handoff", [message("1", "assistant", `${"x".repeat(5000)}conclusion`)], noSources, 1000))!;
  assert.match(context, /earlier characters of this message omitted\] x*conclusion/);
  assert.ok(context.length < 2000);
});

test("activity summaries pair results by call ID, deduplicate requests and collect changed files", () => {
  const entry = (sequence: number, type: JournalEntry["type"], payload: unknown): JournalEntry =>
    ({ sequence, runId: "run", attemptId: "attempt", type, payload, observedAt: "" });
  const summary = summarizeActivity([
    entry(1, "tool_request", { type: "tool_request", tool: "Bash", toolCallId: "a", input: { command: "npm test" } }),
    entry(2, "tool_request", { type: "tool_request", tool: "Bash", toolCallId: "a", input: { command: "npm test" } }),
    entry(3, "tool_result", { type: "tool_result", toolCallId: "a", isError: true, output: "1 failing" }),
    entry(4, "tool_request", { type: "tool_request", tool: "Edit", toolCallId: "b", input: { file_path: "src/a.ts" } }),
  ]);
  assert.deepEqual(summary.actions, ["ran: npm test (failed)", "changed: src/a.ts"]);
  assert.deepEqual(summary.changedFiles, ["src/a.ts"]);
});
