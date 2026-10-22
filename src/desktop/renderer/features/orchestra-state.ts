/** Shared presentation queries; workers remain separate execution sessions. */
import { isWorkflowActive, type WorkflowRun, type WorkflowWorker, type AgentModel } from "../../../features/orchestration/types.js";
import { projectWorkerActivity } from "../../../features/orchestration/activity.js";
import type { AppState } from "../store.js";
export function activeWorkflow(state: AppState) {
  return state.orchestra.runs.find((run) => run.sessionId === state.selection.sessionId && (isWorkflowActive(run) || (state.workflowControls?.[run.id]?.action === "stop" && state.workflowControls[run.id]?.pending)));
}

/** Explicit targets keep Timeline/history links on the requested attempt. */
export interface OrchestraTarget {
  readonly sessionId: string;
  readonly workflowRunId: string;
  readonly workerId?: string;
}

export interface WorkflowStageView {
  readonly id: string;
  readonly name: string;
  readonly kind: "agent" | "parallel" | "approval";
  readonly status: "queued" | "running" | "completed" | "failed" | "stopped" | "waiting_approval";
  readonly current: boolean;
  readonly waitingReason?: string;
  /** All executions stay inspectable; currentWorkers excludes previous revisions. */
  readonly attempts: readonly WorkflowWorker[];
  readonly currentWorkers: readonly WorkflowWorker[];
}

/** Resolve from the immutable run, never the editable library or composer. */
export function resolveWorkflowModel(run: WorkflowRun, model?: AgentModel): AgentModel {
  return model ?? run.workflow.coordinator ?? run.defaultModel;
}

/**
 * Cursor position alone is not completion evidence. A review return invalidates
 * downstream progress while retaining its old attempts, and every parallel
 * member must settle successfully before the group can be complete.
 */
export function workflowStages(run: WorkflowRun): readonly WorkflowStageView[] {
  const round = Object.values(run.reviewRounds).reduce((sum, value) => sum + value, 0);
  return run.workflow.steps.map((step, index) => {
    const attempts = run.workers.filter((worker) => worker.stepId === step.id);
    const latestRound = Math.max(-1, ...attempts.map((worker) => worker.round));
    const current = index === run.stepIndex;
    const revisiting = index >= run.stepIndex && latestRound < round;
    const currentWorkers = revisiting ? [] : attempts.filter((worker) => worker.round === latestRound);
    let status: WorkflowStageView["status"] = "queued";
    if (step.kind === "approval") {
      if (index < run.stepIndex || run.status === "completed") status = "completed";
      else if (current && run.status === "waiting_approval") status = "waiting_approval";
    } else if (index <= run.stepIndex || run.status === "completed") {
      if (currentWorkers.some((worker) => worker.status === "failed")) status = "failed";
      else if (currentWorkers.some((worker) => worker.status === "stopped")) status = "stopped";
      else if (currentWorkers.some((worker) => worker.status === "running")) status = "running";
      else if (currentWorkers.length === step.agents.length && currentWorkers.every((worker) => worker.status === "completed")) status = "completed";
      else if (currentWorkers.some((worker) => worker.status === "completed")) status = "running";
    }
    // Review parsing/limits can fail after the worker itself succeeded.
    if (current && run.status === "failed") status = "failed";
    let waitingReason: string | undefined;
    if (status === "waiting_approval") waitingReason = "Waiting for your workflow approval";
    else if (status === "queued") {
      waitingReason = !isWorkflowActive(run) ? `Workflow ${run.status}; this step did not finish`
        : run.status === "paused" ? "New work waits until you resume"
        : current ? (revisiting ? "Waiting to start the next revision" : "Waiting to start")
        : `Waiting for ${run.workflow.steps[index - 1]?.name ?? "the workflow"} to finish`;
    }
    return { id: step.id, name: step.name, kind: step.kind, status, current, attempts, currentWorkers, ...(waitingReason ? { waitingReason } : {}) };
  });
}

export interface WorkflowRequiredAction {
  readonly kind: "workflow_approval" | "tool_approval" | "question";
  readonly target: OrchestraTarget;
  readonly workerName?: string;
  readonly executionId?: string;
  readonly requestId?: string;
}

/** Broker snapshots alone establish pending actions; journals are history. */
export function workflowRequiredActions(state: AppState, run: WorkflowRun): readonly WorkflowRequiredAction[] {
  const target = { sessionId: run.sessionId, workflowRunId: run.id };
  if (!isWorkflowActive(run)) return [];
  return [
    ...(run.status === "waiting_approval" ? [{ kind: "workflow_approval" as const, target }] : []),
    ...run.workers.flatMap((worker): WorkflowRequiredAction[] => {
      const live = worker.runId ? state.live[worker.runId] : undefined;
      const activity = projectWorkerActivity(worker, live);
      if (!live || !["waiting_approval", "waiting_input"].includes(activity.kind)) return [];
      const base = { target: { ...target, workerId: worker.id }, workerName: worker.name, executionId: worker.runId! };
      return [
        ...live.pendingApprovals.map((request) => ({ ...base, kind: "tool_approval" as const, requestId: request.id })),
        ...(live.pendingQuestions ?? []).map((request) => ({ ...base, kind: "question" as const, requestId: request.id })),
      ];
    }),
  ];
}

/** Summary for UI surfaces; next means the scheduler's next ordered stage. */
export function workflowProgress(run: WorkflowRun) {
  const stages = workflowStages(run);
  return {
    stages,
    completedSteps: stages.filter((stage) => stage.status === "completed").length,
    totalSteps: stages.length,
    current: stages[run.stepIndex],
    next: isWorkflowActive(run) ? stages[run.stepIndex + 1]?.name ?? "Coordinator" : undefined,
  };
}
export function sessionWorkerRunIds(state: AppState): ReadonlySet<string> {
  return new Set(state.orchestra.runs.filter((run) => run.sessionId === state.selection.sessionId).flatMap((run) => run.workers.flatMap((worker) => worker.runId ? [worker.runId] : [])));
}

/** Designers are not workflow workers. Keep their temporary broker routing
 * explicit so a renderer reload cannot strand a hidden child's question. */
export function sessionGenerationRunIds(state: AppState): ReadonlySet<string> {
  return new Set((state.orchestra.generations ?? []).filter((entry) => entry.sessionId === state.selection.sessionId).flatMap((entry) => entry.executionId ? [entry.executionId] : []));
}
