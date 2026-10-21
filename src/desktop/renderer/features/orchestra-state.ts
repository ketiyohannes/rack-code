/** Shared presentation queries; workers remain separate execution sessions. */
import { isWorkflowActive } from "../../../features/orchestration/types.js";
import type { AppState } from "../store.js";
export function activeWorkflow(state: AppState) {
  return state.orchestra.runs.find((run) => run.sessionId === state.selection.sessionId && isWorkflowActive(run));
}
export function sessionWorkerRunIds(state: AppState): ReadonlySet<string> {
  return new Set(state.orchestra.runs.filter((run) => run.sessionId === state.selection.sessionId).flatMap((run) => run.workers.flatMap((worker) => worker.runId ? [worker.runId] : [])));
}
