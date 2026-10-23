import assert from "node:assert/strict";
import test from "node:test";
import type { JournalEntryView, RuntimeEvent } from "@rack/contracts";
import { workerDetail, workerSummary, WorkerJournalReader, type WorkerJournalState } from "./orchestra-worker-state.js";

test("worker tools correlate requests/results using the shared transcript presentation", () => {
  const worker = { id: "worker", name: "Builder", stepId: "build", instructions: "Task", model: { providerId: "fake", runtimeId: "fake", model: "model" }, status: "completed" as const, round: 0, createdAt: "now" };
  const events: RuntimeEvent[] = [
    { type: "tool_request", tool: "shell", toolCallId: "call", input: { command: "npm test" } },
    { type: "tool_result", toolCallId: "call", output: { stdout: "Passed", exitCode: 0 } },
    { type: "message_delta", text: "Done" },
  ];
  const detail = workerDetail(worker, events);
  assert.equal(detail.tools.length, 1);
  assert.equal(detail.tools[0]!.key, "worker:call");
  assert.equal(detail.tools[0]!.presentation.title, "Run command");
  assert.equal(detail.tools[0]!.presentation.subtitle, "npm test");
  assert.equal(detail.tools[0]!.presentation.status, "Completed");
  assert.ok(detail.tools[0]!.presentation.sections.some((section) => section.text === "Passed"));
  assert.equal(detail.response, "Done");
  assert.equal(workerDetail({ ...worker, result: "Retained result" }, events).response, "Retained result");
  const live = { run: { status: "running" as const }, events: events.slice(0, 1), pendingApprovals: [], cancelRequested: false };
  const running = { ...worker, status: "running" as const };
  assert.equal(workerSummary(running, live).action?.target, "npm test");
  assert.equal(workerSummary(running, { ...live, pendingApprovals: [{ id: "approval" }] }).action, undefined);
  assert.equal(workerSummary(running, { ...live, events }).action, undefined);
});

test("journal selection ignores late replies, caches settled reads, and retries failures", async () => {
  let calls = 0;
  let release!: (entries: readonly JournalEntryView[]) => void;
  const reader = new WorkerJournalReader(async (id) => {
    calls++;
    if (id === "slow") return new Promise((resolve) => { release = resolve; });
    if (id === "failure" && calls === 3) throw new Error("Missing journal");
    return [];
  });
  const slowStates: WorkerJournalState[] = [];
  const fastStates: WorkerJournalState[] = [];
  const slow = reader.select("slow", (state) => slowStates.push(state));
  await reader.select("fast", (state) => fastStates.push(state));
  release([]); await slow;
  assert.deepEqual(slowStates.map((state) => state.status), ["loading"]);
  assert.deepEqual(fastStates.map((state) => state.status), ["loading", "ready"]);
  await reader.select("slow", () => {});
  assert.equal(calls, 2);
  const failureStates: WorkerJournalState[] = [];
  await reader.select("failure", (state) => failureStates.push(state));
  assert.equal(failureStates.at(-1)?.status, "error");
  await reader.select("failure", (state) => failureStates.push(state));
  assert.equal(failureStates.at(-1)?.status, "ready");
  assert.equal(calls, 4);
});

test("closing inspection prevents a pending journal from publishing", async () => {
  let release!: (entries: readonly JournalEntryView[]) => void;
  const reader = new WorkerJournalReader(() => new Promise((resolve) => { release = resolve; }));
  const states: WorkerJournalState[] = [];
  const pending = reader.select("run", (state) => states.push(state));
  reader.clearSelection(); release([]); await pending;
  assert.deepEqual(states.map((state) => state.status), ["loading"]);
});
