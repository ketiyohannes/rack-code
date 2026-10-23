/** Scheduler behavior is verified without provider credentials or model calls. */
import assert from "node:assert/strict";
import test from "node:test";
import { OrchestraService, parseVerdict } from "./service.js";
import { validateWorkflow, type OrchestraSnapshot, type OrchestraStore, type WorkflowDefinition, type WorkflowStep } from "./types.js";
import { SessionsService } from "@rack/core/sessions/service";
import { InMemorySessionStore } from "@rack/core/sessions/in-memory-store";
import type { ExecutionHandle, StartRunInput } from "@rack/core/execution/service";
import type { RunRecord } from "@rack/core/execution/types";

class MemoryStore implements OrchestraStore {
  state: OrchestraSnapshot = { workflows: [], bindings: {}, runs: [] };
  async read() { return structuredClone(this.state); }
  async update(change: (state: OrchestraSnapshot) => OrchestraSnapshot) { this.state = structuredClone(change(this.state)); }
}
const agent = (id: string, access: "inherit" | "read_only" = "inherit"): WorkflowStep => ({ id, name: id, kind: "agent", agents: [{ id: `${id}-agent`, name: id, instructions: `Do ${id}`, access }] });
const definition = (steps: readonly WorkflowStep[]): WorkflowDefinition => ({ id: "workflow", name: "Test workflow", description: "", revision: 0, steps });
const base = { sessionId: "root", providerId: "alpha", runtimeId: "alpha-runtime", model: "model-a", permissionMode: "ask" as const, prompt: "Build the requested feature" };
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 3000;
  while (!await check()) { if (Date.now() > end) throw new Error("Timed out waiting for workflow state."); await new Promise((resolve) => setTimeout(resolve, 2)); }
}
async function setup(startGate?: Promise<void>) {
  const store = new MemoryStore();
  const sessions = new SessionsService(new InMemorySessionStore(), { workspace: async (id) => `/tmp/chat-${id}` });
  await sessions.create({ id: "root" });
  const calls: { input: StartRunInput; settle: (result?: string, status?: RunRecord["status"]) => void; cancelled: boolean }[] = [];
  const execution = { conversationContext: async (sessionId: string) => `context of ${sessionId}`, async start(input: StartRunInput): Promise<ExecutionHandle> {
    const id = `run-${calls.length}`;
    let resolve!: (run: RunRecord) => void;
    const completed = new Promise<RunRecord>((done) => { resolve = done; });
    const call = { input, cancelled: false, settle(result = `Result of ${id}`, status: RunRecord["status"] = "completed") {
      resolve({ id, sessionId: input.sessionId, providerId: input.providerId, accountId: "test-account", model: input.model ?? "default", prompt: input.prompt, permissionMode: input.permissionMode, status, result, attemptIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    } };
    calls.push(call);
    if (startGate) await startGate;
    return { runId: id, attemptId: id, completed, events: (async function* () { await completed; })(), respondToApproval() {}, async cancel() { call.cancelled = true; call.settle("Interrupted", "interrupted"); } };
  } };
  const service = new OrchestraService(store, execution, sessions);
  await service.initialize();
  return { store, sessions, calls, service };
}

test("approval gates block execution; worker contexts stay hidden and use explicit model handoffs", async () => {
  const { service, calls, sessions, store } = await setup();
  const build = agent("build");
  const mixed = { ...build, agents: [{ ...build.agents[0]!, model: { providerId: "beta", runtimeId: "beta-runtime", model: "model-b" } }] };
  await service.save(definition([agent("plan", "read_only"), { id: "gate", name: "Approve plan", kind: "approval", agents: [] }, mixed]));
  const run = await service.start(base, "workflow");
  await until(() => calls.length === 1);
  assert.equal(calls[0]!.input.permissionMode, "read_only");
  assert.notEqual(calls[0]!.input.sessionId, "root");
  assert.equal((await sessions.get(calls[0]!.input.sessionId)).parentSessionId, "root");
  assert.deepEqual((await sessions.listSummaries()).map((session) => session.id), ["root"]);
  assert.equal(await sessions.workspace(calls[0]!.input.sessionId), "/tmp/chat-root");
  calls[0]!.settle("Approved implementation plan");
  await until(() => store.state.runs[0]?.status === "waiting_approval");
  assert.equal(calls.length, 1);
  await assert.rejects(service.control(run.id, "resume"), /paused/);
  await service.control(run.id, "approve");
  await until(() => calls.length === 2);
  assert.equal(calls[1]!.input.model, "model-b");
  assert.equal(calls[1]!.input.runtimeId, "beta-runtime");
  assert.match(calls[1]!.input.prompt, /Approved implementation plan/);
  calls[1]!.settle("Implemented and tested");
  await until(() => calls.length === 3);
  assert.equal(calls[2]!.input.model, "model-a");
  assert.equal(calls[2]!.input.permissionMode, "read_only");
  calls[2]!.settle("Final answer");
  await until(() => store.state.runs[0]?.status === "completed");
  assert.equal((await sessions.get("root")).messages.at(-1)?.content, "Final answer");
});

test("parallel workers run together, pause blocks subsequent stages, and running definitions are immutable", async () => {
  const { service, calls, store } = await setup();
  const parallel: WorkflowStep = { id: "parallel", name: "Research", kind: "parallel", agents: [agent("one", "read_only").agents[0]!, agent("two", "read_only").agents[0]!] };
  const saved = await service.save(definition([parallel, agent("build")]));
  const run = await service.start(base, "workflow");
  await until(() => calls.length === 2);
  await service.control(run.id, "pause");
  await service.save({ ...saved, name: "Edited for future runs", steps: [agent("different")] });
  calls[0]!.settle("Research A"); calls[1]!.settle("Research B");
  await until(() => store.state.runs[0]?.stepIndex === 1);
  assert.equal(store.state.runs[0]!.status, "paused");
  assert.equal(calls.length, 2);
  assert.equal(store.state.runs[0]!.workflow.name, "Test workflow");
  await service.control(run.id, "resume");
  await until(() => calls.length === 3);
  assert.match(calls[2]!.input.prompt, /Research A/); assert.match(calls[2]!.input.prompt, /Research B/);
  await service.control(run.id, "stop");
  await until(() => !service.isBusy("root"));
  assert.equal(calls[2]!.cancelled, true);
  assert.equal(store.state.runs[0]!.status, "stopped");
});

test("review findings return to the requested stage and stop at the configured limit", async () => {
  const { service, calls, store } = await setup();
  await service.save(definition([agent("build"), { ...agent("review", "read_only"), review: { returnTo: "build", maxRounds: 1 } }]));
  await service.start(base, "workflow");
  await until(() => calls.length === 1); calls[0]!.settle("Build 1");
  await until(() => calls.length === 2); calls[1]!.settle("Fix the failing case\nVERDICT: CHANGES_REQUESTED");
  await until(() => calls.length === 3); assert.match(calls[2]!.input.prompt, /Fix the failing case/); calls[2]!.settle("Build 2");
  await until(() => calls.length === 4); calls[3]!.settle("Still broken\nVERDICT: CHANGES_REQUESTED");
  await until(() => store.state.runs[0]?.status === "failed");
  assert.match(store.state.runs[0]!.error!, /limit of 1/); assert.equal(calls.length, 4);
});

test("invalid review output cannot silently approve work", async () => {
  const { service, calls, store } = await setup();
  await service.save(definition([agent("build"), { ...agent("review", "read_only"), review: { returnTo: "build", maxRounds: 1 } }]));
  await service.start(base, "workflow");
  await until(() => calls.length === 1); calls[0]!.settle();
  await until(() => calls.length === 2); calls[1]!.settle("Looks fine probably");
  await until(() => store.state.runs[0]?.status === "failed");
  assert.match(store.state.runs[0]!.error!, /no valid review verdict/);
});

test("restart preserves history and never replays uncertain work", async () => {
  const { service, calls, store, sessions } = await setup();
  await service.save(definition([agent("build")]));
  const run = await service.start(base, "workflow"); await until(() => calls.length === 1);
  const restoredStore = new MemoryStore(); restoredStore.state = structuredClone(store.state);
  let executions = 0;
  const restored = new OrchestraService(restoredStore, { conversationContext: async () => undefined, start: async () => { executions++; throw new Error("Must not execute"); } }, sessions);
  await restored.initialize();
  assert.equal(restoredStore.state.runs[0]!.status, "interrupted"); assert.equal(executions, 0);
  await assert.rejects(restored.control(run.id, "resume"), /no longer active/);
  await service.control(run.id, "stop");
});

test("definitions reject invalid loops, duplicate identities and writable parallel agents", () => {
  const step = agent("build");
  assert.throws(() => validateWorkflow(definition([step, step])), /unique/);
  assert.throws(() => validateWorkflow(definition([{ ...step, review: { returnTo: "missing", maxRounds: 2 } }])), /earlier/);
  assert.throws(() => validateWorkflow(definition([{ id: "p", name: "Parallel", kind: "parallel", agents: [agent("a").agents[0]!, agent("b", "read_only").agents[0]!] }])), /read-only/);
});

test("binding removal keeps past run snapshots and stale library saves fail", async () => {
  const { service, store } = await setup();
  const saved = await service.save(definition([agent("plan")]));
  await service.bind("root", saved.id); assert.equal(store.state.bindings["root"], saved.id);
  await service.save({ ...saved, name: "New title" });
  await assert.rejects(service.save(saved), /another window/);
  await service.remove(saved.id); assert.equal(store.state.bindings["root"], undefined);
});

test("a failed parallel worker cancels its blocked siblings instead of hanging the workflow", async () => {
  const { service, calls, store } = await setup();
  await service.save(definition([{ id: "parallel", name: "Research", kind: "parallel", agents: [agent("a", "read_only").agents[0]!, agent("b", "read_only").agents[0]!] }]));
  await service.start(base, "workflow"); await until(() => calls.length === 2);
  calls[0]!.settle("Failed", "failed");
  await until(() => store.state.runs[0]?.status === "failed");
  assert.equal(calls[1]!.cancelled, true);
  await until(() => !service.isBusy("root"));
});

test("workflow generation uses a read-only model request and validates its output without running it", async () => {
  const { service, calls, store } = await setup();
  const generated = service.generate("root", "Plan then build", { providerId: "alpha", runtimeId: "alpha-runtime", model: "model-a" });
  await until(() => calls.length === 1);
  assert.equal(calls[0]!.input.permissionMode, "read_only");
  calls[0]!.settle(JSON.stringify(definition([agent("plan", "read_only"), agent("build")])));
  const result = await generated;
  assert.equal(result.steps.length, 2); assert.equal(result.revision, 0);
  assert.equal(calls.length, 1); assert.equal(store.state.workflows.length, 0); assert.equal(store.state.runs.length, 0);
  const invalid = service.generate("root", "Run a workflow", { providerId: "alpha", runtimeId: "alpha-runtime", model: "model-a" });
  await until(() => calls.length === 2); calls[1]!.settle('{"steps":[]}');
  await assert.rejects(invalid, /valid coordinator|workflow needs/);
});

test("review verdicts tolerate model formatting but still require an explicit verdict line", () => {
  assert.equal(parseVerdict("Looks good.\nVERDICT: APPROVED"), "APPROVED");
  assert.equal(parseVerdict("Findings...\n\n**VERDICT: CHANGES_REQUESTED**\n"), "CHANGES_REQUESTED");
  assert.equal(parseVerdict("`VERDICT: approved.`\nLet me know if you need anything else."), "APPROVED");
  assert.equal(parseVerdict("VERDICT: changes requested"), "CHANGES_REQUESTED");
  assert.equal(parseVerdict("I would say this is APPROVED overall."), undefined);
  assert.equal(parseVerdict("VERDICT: APPROVED\n1\n2\n3\n4\n5"), undefined, "only the closing lines are considered");
});

test("designer executions expose a transient root association and cancel without saving a draft", async () => {
  const { service, calls, store } = await setup();
  const generated = service.generate("root", "Ask a question", { providerId: "alpha", runtimeId: "alpha-runtime", model: "model-a" }, "designer-request");
  const rejected = assert.rejects(generated, /cancelled/);
  await until(async () => (await service.snapshot()).generations?.[0]?.executionId === "run-0");
  assert.deepEqual((await service.snapshot()).generations, [{ id: "designer-request", sessionId: "root", executionId: "run-0", stopping: false }]);
  assert.equal(service.isBusy("root"), true);
  assert.equal(store.state.generations, undefined, "designer associations must never enter durable storage");
  await Promise.all([service.cancelGeneration("designer-request"), service.cancelGeneration("designer-request")]);
  await rejected;
  assert.equal(calls[0]!.cancelled, true);
  assert.equal(service.isBusy("root"), false);
  assert.deepEqual((await service.snapshot()).generations, []);
  assert.deepEqual(store.state.workflows, []);
});

test("cancelling a designer before its execution starts prevents launching it", async () => {
  const { service, calls } = await setup();
  const generated = service.generate("root", "Cancel immediately", { providerId: "alpha", runtimeId: "alpha-runtime", model: "model-a" }, "early-request");
  const rejected = assert.rejects(generated, /cancelled/);
  await service.cancelGeneration("early-request");
  await rejected;
  assert.equal(calls.length, 0);
  assert.equal(service.isBusy("root"), false);
});

test("shutdown also settles a designer execution waiting for input", async () => {
  const { service, calls } = await setup();
  const generated = service.generate("root", "Wait for an answer", { providerId: "alpha", runtimeId: "alpha-runtime", model: "model-a" }, "shutdown-request");
  const rejected = assert.rejects(generated, /cancelled/);
  await until(async () => !!(await service.snapshot()).generations?.[0]?.executionId);
  await service.stopAll(); await rejected;
  assert.equal(calls[0]!.cancelled, true);
  assert.equal(service.isBusy("root"), false);
});

test("designer cancellation waits for an in-flight execution start and cancels its eventual handle", async () => {
  let release!: () => void;
  const { service, calls } = await setup(new Promise<void>((resolve) => { release = resolve; }));
  const generated = service.generate("root", "Slow startup", { providerId: "alpha", runtimeId: "alpha-runtime", model: "model-a" }, "starting-request");
  const rejected = assert.rejects(generated, /cancelled/);
  await until(() => calls.length === 1);
  let stopped = false;
  const cancelled = service.cancelGeneration("starting-request").then(() => { stopped = true; });
  assert.equal(stopped, false);
  assert.equal((await service.snapshot()).generations?.[0]?.stopping, true);
  release(); await cancelled; await rejected;
  assert.equal(calls[0]!.cancelled, true);
  assert.equal(service.isBusy("root"), false);
});

test("designer observation failure cancels its execution before removing the association", async () => {
  const { service, calls } = await setup();
  service.observeExecutions(async () => { throw new Error("Host observation failed"); });
  await assert.rejects(service.generate("root", "Draft a workflow", { providerId: "alpha", runtimeId: "alpha-runtime", model: "model-a" }, "observation-request"), /Host observation failed/);
  assert.equal(calls[0]!.cancelled, true);
  assert.equal(service.isBusy("root"), false);
  assert.deepEqual((await service.snapshot()).generations, []);
});

test("workers are briefed with the existing conversation of the session", async () => {
  const { service, calls, sessions } = await setup();
  await sessions.appendMessage("root", { role: "user", content: "Earlier work" });
  await service.save(definition([agent("build")]));
  const run = await service.start(base, "workflow"); await until(() => calls.length === 1);
  assert.match(calls[0]!.input.prompt, /CONVERSATION CONTEXT \(historical data\):\ncontext of root/);
  await service.control(run.id, "stop");
});
