/** Pure startup reconciliation shared by durable and in-memory execution stores. */
import type { AttemptRecord, JournalEntry, RunRecord } from "./types.js";
export function recoverExecutionState(state: {
  readonly runs: readonly RunRecord[]; readonly attempts: readonly AttemptRecord[]; readonly journal: readonly JournalEntry[];
}, observedAt: string): { runs: RunRecord[]; attempts: AttemptRecord[]; journal: JournalEntry[] } {
  const abandoned = state.runs.filter((run) => run.status === "queued" || run.status === "running");
  const ids = new Set(abandoned.map((run) => run.id));
  const reason = "The execution host stopped before this run recorded a final outcome. Review the saved activity before continuing.";
  // Run, attempt and recovery journal updates belong to one store transaction.
  // Unknown deliberately avoids claiming that an external action was rolled back.
  return {
    runs: state.runs.map((run) => ids.has(run.id) ? { ...run, status: "unknown", error: reason, updatedAt: observedAt } : run),
    attempts: state.attempts.map((attempt) => attempt.status === "queued" || attempt.status === "running" ? { ...attempt, status: "unknown", updatedAt: observedAt } : attempt),
    journal: [...state.journal, ...abandoned.map((run, index): JournalEntry => ({ sequence: (state.journal.at(-1)?.sequence ?? 0) + index + 1,
      runId: run.id, attemptId: run.attemptIds.at(-1) ?? "recovery", type: "run_status", payload: { status: "unknown", reason: "host_restart", error: reason }, observedAt }))],
  };
}
