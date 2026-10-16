import type { AttemptId, AttemptRecord, JournalEntry, RunId, RunRecord, RunUsage } from "./types.js";

export interface ExecutionStore {
  /** Host startup only: atomically settle abandoned runs/attempts and append recovery records. */
  recoverInterruptedRuns(observedAt: string): Promise<void>;
  /** Detached usage-only projection, including runs whose sessions were removed. */
  listRunUsage(): Promise<readonly RunUsage[]>;
  getRun(runId: RunId): Promise<RunRecord | undefined>;
  /** Lists runs that belong to one application session, in any order. */
  listRuns(sessionId: string): Promise<readonly RunRecord[]>;
  saveRun(run: RunRecord): Promise<void>;
  getAttempt(attemptId: AttemptId): Promise<AttemptRecord | undefined>;
  saveAttempt(attempt: AttemptRecord): Promise<void>;
  appendJournal(entry: Omit<JournalEntry, "sequence">): Promise<JournalEntry>;
  listJournal(runId: RunId): Promise<readonly JournalEntry[]>;
}
