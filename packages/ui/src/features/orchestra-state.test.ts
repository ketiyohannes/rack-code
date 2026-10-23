import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowRun, WorkflowWorker } from "@rack/features/orchestration/types";
import { INITIAL_STATE } from "../store.js";
import { workflowTemplate } from "./orchestra-templates.js";
import { activeWorkflow, resolveWorkflowModel, workflowRequiredActions, workflowStages, sessionGenerationRunIds } from "./orchestra-state.js";

const model = { providerId: "fake", runtimeId: "runtime", model: "one" };
const workflow = workflowTemplate();
const fixture: WorkflowRun = { id: "workflow-run", sessionId: "chat", workflow, prompt: "Task", status: "running", stepIndex: 2, workers: [], reviewRounds: {}, defaultModel: model, permissionMode: "ask", revision: 1, createdAt: "now", updatedAt: "now" };
const worker = (index: number, status: WorkflowWorker["status"], round = 0): WorkflowWorker => ({ id: `${index}-${round}`, stepId: workflow.steps[index]!.id, name: "Worker", instructions: "Task", model, status, round, createdAt: "now" });

test("designer broker routing includes only the selected root's associated executions", () => {
  const state = { ...INITIAL_STATE, selection: { sessionId: "chat" }, orchestra: { ...INITIAL_STATE.orchestra, generations: [
    { id: "one", sessionId: "chat", executionId: "designer-one", stopping: false },
    { id: "two", sessionId: "other", executionId: "designer-two", stopping: false },
    { id: "starting", sessionId: "chat", stopping: false },
  ] } };
  assert.deepEqual([...sessionGenerationRunIds(state)], ["designer-one"]);
  assert.equal(sessionGenerationRunIds(INITIAL_STATE).size, 0);
});

test("review returns retain attempts without presenting stale downstream completion", () => {
  const plan = worker(0, "completed");
  const build = worker(2, "completed");
  const review = worker(3, "completed");
  const run = { ...fixture, workers: [plan, build, review], reviewRounds: { [workflow.steps[3]!.id]: 1 } };
  const stages = workflowStages(run);
  assert.equal(stages[0]!.status, "completed");
  assert.equal(stages[1]!.status, "completed");
  assert.equal(stages[2]!.status, "queued");
  assert.deepEqual(stages[2]!.attempts, [build]);
  assert.deepEqual(stages[2]!.currentWorkers, []);
  assert.match(stages[2]!.waitingReason!, /revision/);
  assert.equal(stages[3]!.status, "queued");
  const revising = workflowStages({ ...run, workers: [...run.workers, worker(2, "running", 1)] });
  assert.equal(revising[2]!.status, "running");
  assert.equal(revising[2]!.attempts.length, 2);
});

test("parallel completion requires every member; failure wins over surviving siblings", () => {
  const parallel = workflowTemplate("review");
  const first = { ...worker(0, "completed"), stepId: parallel.steps[0]!.id };
  const second = { ...first, id: "second", status: "running" as const };
  const run = { ...fixture, workflow: parallel, stepIndex: 0 };
  assert.equal(workflowStages({ ...run, workers: [first] })[0]!.status, "running");
  assert.equal(workflowStages({ ...run, workers: [first, second] })[0]!.status, "running");
  assert.equal(workflowStages({ ...run, workers: [first, { ...second, status: "completed" }] })[0]!.status, "completed");
  assert.equal(workflowStages({ ...run, workers: [{ ...first, status: "failed" }, second] })[0]!.status, "failed");
});

test("terminal errors, workflow gates and pause reasons describe scheduling truthfully", () => {
  assert.equal(workflowStages({ ...fixture, status: "failed", workers: [worker(2, "completed")] })[2]!.status, "failed");
  assert.equal(workflowStages({ ...fixture, status: "waiting_approval", stepIndex: 1 })[1]!.status, "waiting_approval");
  assert.match(workflowStages({ ...fixture, status: "paused" })[2]!.waitingReason!, /resume/);
  assert.equal(workflowStages({ ...fixture, stepIndex: 3 })[2]!.status, "queued", "cursor movement is not evidence of successful work");
});

test("required actions use pending brokers and target the exact worker attempt", () => {
  const active = { ...worker(2, "running", 1), runId: "execution" };
  const run = { ...fixture, workers: [active] };
  const state = { ...INITIAL_STATE, live: { execution: { run: { status: "running" }, events: [], pendingApprovals: [{ id: "a" }], pendingQuestions: [{ id: "q" }], cancelRequested: false } } } as unknown as typeof INITIAL_STATE;
  const actions = workflowRequiredActions(state, run);
  assert.deepEqual(actions.map((action) => action.kind), ["tool_approval", "question"]);
  assert.deepEqual(actions[0]!.target, { sessionId: "chat", workflowRunId: run.id, workerId: active.id });
  assert.equal(workflowRequiredActions(INITIAL_STATE, run).length, 0);
  assert.equal(workflowRequiredActions(state, { ...run, status: "stopped" }).length, 0);
  assert.equal(workflowRequiredActions(state, { ...run, status: "waiting_approval" })[0]!.kind, "workflow_approval");
});

test("stopping remains active only until cancellation settles; models use the run snapshot", () => {
  const run = { ...fixture, status: "stopped" as const };
  const state = { ...INITIAL_STATE, selection: { sessionId: "chat" }, orchestra: { ...INITIAL_STATE.orchestra, runs: [run] }, workflowControls: { [run.id]: { action: "stop" as const, pending: true } } };
  assert.equal(activeWorkflow(state)?.id, run.id);
  assert.equal(activeWorkflow({ ...state, workflowControls: { [run.id]: { action: "stop", pending: false, error: "Failed" } } }), undefined);
  assert.deepEqual(resolveWorkflowModel(run), model);
});
