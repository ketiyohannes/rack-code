/** Regression fixtures for normalized worker activity, with no provider calls. */
import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeEvent } from "@rack/core/execution/types";
import { projectWorkerActivity, type WorkerExecutionActivity } from "./activity.js";

const worker = { status: "running" as const };
const request = (tool: string, toolCallId?: string): RuntimeEvent => ({ type: "tool_request", tool, input: {}, ...(toolCallId === undefined ? {} : { toolCallId }) });
const result = (toolCallId?: string): RuntimeEvent => ({ type: "tool_result", output: "done", ...(toolCallId === undefined ? {} : { toolCallId }) });
const execution = (events: readonly RuntimeEvent[], overrides: Partial<WorkerExecutionActivity> = {}): WorkerExecutionActivity => ({
  run: { status: "running" }, events, pendingApprovals: [], pendingQuestions: [], cancelRequested: false, ...overrides,
});

test("completed tools clear; overlapping tools settle by identity in either order", () => {
  const started = [request("shell", "a"), request("search", "b")];
  assert.deepEqual(projectWorkerActivity(worker, execution(started)), { kind: "tool", label: "Running search · 2 tools", activeToolCount: 2 });
  assert.deepEqual(projectWorkerActivity(worker, execution([...started, result("b")])), { kind: "tool", label: "Running shell", activeToolCount: 1 });
  assert.equal(projectWorkerActivity(worker, execution([...started, result("a")])).label, "Running search");
  assert.equal(projectWorkerActivity(worker, execution([...started, result("b"), result("a")])).kind, "working");
});

test("consecutive requests change the displayed signature while ordinary response deltas do not", () => {
  const signature = (events: readonly RuntimeEvent[]) => JSON.stringify(projectWorkerActivity(worker, execution(events)));
  const shell = [request("shell", "a")];
  const search = [...shell, request("search", "b")];
  assert.notEqual(signature(shell), signature(search));
  assert.notEqual(signature(search), signature([...search, result("b")]));
  assert.equal(signature([{ type: "message_delta", text: "Hello" }]), signature([{ type: "message_delta", text: "Hello" }, { type: "message_delta", text: " there" }]));
});

test("repeated call IDs update attribution without multiplying tools; unrelated results cannot finish them", () => {
  const events = [request("shell", "a"), request("updated shell", "a"), result("other")];
  assert.deepEqual(projectWorkerActivity(worker, execution(events)), { kind: "tool", label: "Running updated shell", activeToolCount: 1 });
});

test("missing correlation falls back without claiming an active or completed tool", () => {
  for (const events of [[request("legacy")], [request("legacy"), result()], [request("shell", "a"), result()], [request("shell", "a"), request("legacy")]]) {
    assert.deepEqual(projectWorkerActivity(worker, execution(events)), { kind: "working", label: "Working" });
  }
  assert.equal(projectWorkerActivity(worker, execution([request("legacy"), result(), request("search", "b")])).label, "Running search");
});

test("pending broker input overrides tools and clears when answered", () => {
  const events: RuntimeEvent[] = [request("shell", "a"), { type: "approval_request", request: { id: "approval", tool: "shell", input: {} } }];
  assert.equal(projectWorkerActivity(worker, execution(events, { pendingApprovals: [{ id: "approval" }] })).kind, "waiting_approval");
  assert.equal(projectWorkerActivity(worker, execution(events)).kind, "tool", "an old approval event is not pending broker state");
  assert.equal(projectWorkerActivity(worker, execution(events, { pendingQuestions: [{ id: "question" }] })).kind, "waiting_input");
  assert.equal(projectWorkerActivity(worker, execution([...events, { type: "question_resolved", requestId: "question", response: null }])).kind, "tool");
});

test("cancellation overrides pending input until actual settlement", () => {
  const live = execution([request("shell", "a")], { cancelRequested: true, pendingApprovals: [{ id: "approval" }], pendingQuestions: [{ id: "question" }] });
  assert.deepEqual(projectWorkerActivity(worker, live), { kind: "stopping", label: "Stopping" });
  assert.equal(projectWorkerActivity({ status: "stopped" }, live).label, "Stopped");
  assert.equal(projectWorkerActivity(worker, { ...live, run: { status: "interrupted" } }).label, "Interrupted");
});

test("all terminal sources override stale tools, approvals, and trailing metadata", () => {
  const live = execution([request("shell", "a")], { pendingApprovals: [{ id: "approval" }] });
  for (const status of ["completed", "failed", "stopped"] as const) {
    assert.equal(projectWorkerActivity({ status }, live).kind, "finished");
    assert.equal(projectWorkerActivity({ status }).kind, "finished", "reload needs no live execution");
  }
  for (const status of ["completed", "failed", "interrupted", "unknown"] as const) {
    assert.ok(["finished", "unavailable"].includes(projectWorkerActivity(worker, { ...live, run: { status } }).kind));
  }
  for (const terminal of [{ type: "completed", result: "done" }, { type: "failed", error: "failure" }, { type: "interrupted" }] as const) {
    assert.equal(projectWorkerActivity(worker, { ...live, events: [...live.events, terminal, { type: "usage", outputTokens: 5 }] }).kind, "finished");
  }
});

test("parallel executions and revisions with identical tool IDs remain independent", () => {
  const builder = execution([request("shell", "shared-id")]);
  const reviewer = execution([request("search", "shared-id"), result("shared-id")]);
  const revision = execution([request("read", "shared-id")]);
  assert.equal(projectWorkerActivity(worker, builder).label, "Running shell");
  assert.equal(projectWorkerActivity(worker, reviewer).label, "Working");
  assert.equal(projectWorkerActivity(worker, revision).label, "Running read");
  assert.equal(projectWorkerActivity(worker, builder).label, "Running shell");
});

test("queued and missing history stay explicit; silence never implies thinking", () => {
  assert.deepEqual(projectWorkerActivity({ status: "queued" }), { kind: "queued", label: "Waiting" });
  assert.deepEqual(projectWorkerActivity(worker), { kind: "unavailable", label: "Activity unavailable" });
  assert.equal(projectWorkerActivity(worker, execution([], { run: { status: "queued" } })).kind, "queued");
  assert.equal(projectWorkerActivity(worker, execution([])).label, "Working");
  assert.equal(projectWorkerActivity(worker, execution([{ type: "message_delta", text: "Answer" }])).label, "Writing response");
  assert.equal(projectWorkerActivity(worker, execution([{ type: "thinking_delta", text: "private" }])).label, "Working");
});

test("tool summaries are bounded and exclude arguments and output", () => {
  const activity = projectWorkerActivity(worker, execution([{ type: "tool_request", tool: `custom\n${"x".repeat(200)}`, toolCallId: "a", input: { command: "private command" } }]));
  assert.equal(activity.label.length, "Running ".length + 80);
  assert.ok(!activity.label.includes("\n"));
  assert.ok(!activity.label.includes("private command"));
});
