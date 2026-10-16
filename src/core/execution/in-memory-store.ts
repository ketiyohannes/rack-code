import { recoverExecutionState } from "./recovery.js";
import type { ExecutionStore } from "./ports.js";
import type { AttemptId, AttemptRecord, JournalEntry, RunId, RunRecord, RunUsage } from "./types.js";

/** Headless execution store for tests and adapter integration. */
export class InMemoryExecutionStore implements ExecutionStore {
  private readonly runs = new Map<RunId, RunRecord>();
  private readonly attempts = new Map<AttemptId, AttemptRecord>();
  private readonly journal: JournalEntry[] = [];

  async recoverInterruptedRuns(observedAt: string): Promise<void> {
    const recovered = recoverExecutionState({ runs: [...this.runs.values()], attempts: [...this.attempts.values()], journal: this.journal }, observedAt);
    for (const run of recovered.runs) this.runs.set(run.id, run);
    for (const attempt of recovered.attempts) this.attempts.set(attempt.id, attempt);
    this.journal.splice(0, this.journal.length, ...recovered.journal);
  }

  async listRunUsage(): Promise<readonly RunUsage[]> {
    return structuredClone([...this.runs.values()].map((run) => ({ run: { id: run.id, ...(run.projectId === undefined ? {} : { projectId: run.projectId }), providerId: run.providerId, status: run.status, createdAt: run.createdAt, ...(run.model === undefined ? {} : { model: run.model }) }, usage: this.journal.filter((entry) => entry.runId === run.id && entry.type === "usage") })));
  }

  async getRun(runId: RunId): Promise<RunRecord | undefined> {
    const run = this.runs.get(runId);
    return run === undefined ? undefined : { ...run, attemptIds: [...run.attemptIds] };
  }

  async listRuns(sessionId: string): Promise<readonly RunRecord[]> {
    return [...this.runs.values()]
      .filter((run) => run.sessionId === sessionId)
      .map((run) => ({ ...run, attemptIds: [...run.attemptIds] }));
  }

  async saveRun(run: RunRecord): Promise<void> {
    this.runs.set(run.id, { ...run, attemptIds: [...run.attemptIds] });
  }

  async getAttempt(attemptId: AttemptId): Promise<AttemptRecord | undefined> {
    const attempt = this.attempts.get(attemptId);
    return attempt === undefined ? undefined : { ...attempt };
  }

  async saveAttempt(attempt: AttemptRecord): Promise<void> {
    this.attempts.set(attempt.id, { ...attempt });
  }

  async appendJournal(entry: Omit<JournalEntry, "sequence">): Promise<JournalEntry> {
    const stored: JournalEntry = { ...entry, sequence: this.journal.length + 1 };
    this.journal.push(stored);
    return { ...stored };
  }

  async listJournal(runId: RunId): Promise<readonly JournalEntry[]> {
    return this.journal.filter((entry) => entry.runId === runId).map((entry) => ({ ...entry }));
  }
}
