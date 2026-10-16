import { recoverExecutionState } from "../../core/execution/recovery.js";
import { JsonFileDocument } from "./json-file.js";
import type { ExecutionStore } from "../../core/execution/ports.js";
import type { AttemptId, AttemptRecord, JournalEntry, RunId, RunRecord, RunUsage } from "../../core/execution/types.js";

interface ExecutionDocument {
  readonly schemaVersion: 3;
  readonly runs: RunRecord[];
  readonly attempts: AttemptRecord[];
  readonly journal: JournalEntry[];
}

type LegacyRun = Omit<RunRecord, "projectId"> & { projectId?: string; workspaceId?: string };

/** Durable snapshots and journal; schema 3 resolves duplicate project IDs. */
export class JsonExecutionStore implements ExecutionStore {
  private readonly document: JsonFileDocument<ExecutionDocument>;

  constructor(filePath: string, resolveProjectId: (id: string) => Promise<string> = async (id) => id) {
    this.document = new JsonFileDocument<ExecutionDocument>(filePath, {
      schemaVersion: 3,
      runs: [],
      attempts: [],
      journal: [],
    }, async (stored) => {
      const current = stored as ExecutionDocument;
      const version = (stored as { schemaVersion: number }).schemaVersion;
      if (version === 3) return current;
      if (version !== 1 && version !== 2) {
        throw new Error("Unsupported execution schema version.");
      }
      return {
        ...current,
        schemaVersion: 3,
        // Preserve the journal, attempt IDs and outcomes exactly. Only the
        // run's folder reference changes to the canonical project name.
        runs: await Promise.all(current.runs.map(async (run) => {
          const { workspaceId, ...rest } = run as LegacyRun;
          const projectId = workspaceId ?? rest.projectId;
          if (projectId === undefined || projectId.trim() === "") {
            throw new Error(`Run '${run.id}' has no saved project folder reference.`);
          }
          return { ...rest, projectId: await resolveProjectId(projectId) };
        })),
      };
    });
  }

  async recoverInterruptedRuns(observedAt: string): Promise<void> {
    await this.document.update((current) => ({ ...current, ...recoverExecutionState(current, observedAt) }));
  }

  async listRunUsage(): Promise<readonly RunUsage[]> {
    return this.document.select((value) => {
      const byRun = new Map<string, JournalEntry[]>();
      for (const entry of value.journal) if (entry.type === "usage") {
        const entries = byRun.get(entry.runId) ?? [];
        entries.push(entry); byRun.set(entry.runId, entries);
      }
      return value.runs.map((run) => ({ run: { id: run.id, projectId: run.projectId, providerId: run.providerId, status: run.status, createdAt: run.createdAt, ...(run.model === undefined ? {} : { model: run.model }) }, usage: byRun.get(run.id) ?? [] }));
    });
  }

  async getRun(runId: RunId): Promise<RunRecord | undefined> {
    return this.document.select((value) => value.runs.find((run) => run.id === runId));
  }

  async listRuns(sessionId: string): Promise<readonly RunRecord[]> {
    return this.document.select((value) => value.runs.filter((run) => run.sessionId === sessionId));
  }

  async saveRun(run: RunRecord): Promise<void> {
    await this.document.update((current) => ({
      ...current,
      runs: [...current.runs.filter((candidate) => candidate.id !== run.id), run],
    }));
  }

  async getAttempt(attemptId: AttemptId): Promise<AttemptRecord | undefined> {
    return this.document.select((value) => value.attempts.find((attempt) => attempt.id === attemptId));
  }

  async saveAttempt(attempt: AttemptRecord): Promise<void> {
    await this.document.update((current) => ({
      ...current,
      attempts: [
        ...current.attempts.filter((candidate) => candidate.id !== attempt.id),
        attempt,
      ],
    }));
  }

  async appendJournal(entry: Omit<JournalEntry, "sequence">): Promise<JournalEntry> {
    const document = await this.document.update((current) => {
      const stored: JournalEntry = {
        ...entry,
        sequence: current.journal.length + 1,
      };
      return { ...current, journal: [...current.journal, stored] };
    });
    return document.journal[document.journal.length - 1] as JournalEntry;
  }

  async listJournal(runId: RunId): Promise<readonly JournalEntry[]> {
    return this.document.select((value) => value.journal.filter((entry) => entry.runId === runId));
  }
}
