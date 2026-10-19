import { mkdir, open, readFile, rename, truncate, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { recoverExecutionState } from "../../core/execution/recovery.js";
import { JsonFileDocument } from "./json-file.js";
import type { ExecutionStore } from "../../core/execution/ports.js";
import type { AttemptId, AttemptRecord, JournalEntry, RunId, RunRecord, RunUsage } from "../../core/execution/types.js";

interface ExecutionDocument {
  readonly schemaVersion: 4;
  readonly runs: RunRecord[];
  readonly attempts: AttemptRecord[];
  readonly journal: JournalEntry[];
}
type LegacyRun = Omit<RunRecord, "projectId"> & { projectId?: string; workspaceId?: string };
interface Transaction {
  readonly runs?: readonly RunRecord[];
  readonly attempts?: readonly AttemptRecord[];
  readonly journal?: readonly JournalEntry[];
}
type LogRecord = { readonly version: 1; readonly snapshot: ExecutionDocument } | { readonly transaction: Transaction };

/**
 * Single-owner execution store backed by a self-contained append-only log.
 * The legacy JSON file is migrated once through its existing schema rules,
 * then atomically copied into the first log record. The log is authoritative
 * thereafter; the JSON remains a rollback backup and is never dual-written.
 *
 * A newline commits one transaction (including startup recovery). Appends
 * are serialized, flushed before publication, and indexed in memory by run.
 * Reads clone only their result, never the entire accumulated history. On
 * restart an incomplete final record is discarded; corrupt committed records
 * fail closed. Like the previous store, this requires one live host owner.
 */
export class JsonExecutionStore implements ExecutionStore {
  private readonly logPath: string;
  private loading: Promise<void> | undefined;
  private writes: Promise<void> = Promise.resolve();
  private poisoned: unknown;
  private size = 0;
  private sequence = 0;
  private readonly runs = new Map<string, RunRecord>();
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly journal = new Map<string, JournalEntry[]>();
  private readonly usage = new Map<string, JournalEntry[]>();

  constructor(private readonly filePath: string, private readonly resolveProjectId: (id: string) => Promise<string> = async (id) => id) {
    this.logPath = `${filePath}.log`;
  }

  private ready(): Promise<void> { return this.loading ??= this.load(); }

  private async load(): Promise<void> {
    let content: Buffer;
    try { content = await readFile(this.logPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Existing migration tests and older data use this same normalization.
      // No log is published until the entire snapshot is safely written.
      const legacy = new JsonFileDocument<ExecutionDocument>(this.filePath,
        { schemaVersion: 4, runs: [], attempts: [], journal: [] }, async (stored) => {
          const current = stored as ExecutionDocument;
          const version = (stored as { schemaVersion: number }).schemaVersion;
          if (version === 4) return current;
          if (version === 3) return { ...current, schemaVersion: 4 };
          if (version !== 1 && version !== 2) throw new Error("Unsupported execution schema version.");
          return { ...current, schemaVersion: 4, runs: await Promise.all(current.runs.map(async (run) => {
            const { workspaceId, ...rest } = run as LegacyRun;
            const projectId = workspaceId ?? rest.projectId;
            if (!projectId?.trim()) throw new Error(`Run '${run.id}' has no saved project folder reference.`);
            return { ...rest, projectId: await this.resolveProjectId(projectId) };
          })) };
        });
      const snapshot = await legacy.read();
      content = Buffer.from(`${JSON.stringify({ version: 1, snapshot } satisfies LogRecord)}\n`);
      await mkdir(dirname(this.logPath), { recursive: true });
      const temporary = `${this.logPath}.${process.pid}.tmp`;
      await writeFile(temporary, content, { mode: 0o600 });
      const file = await open(temporary, "r+");
      try { await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.logPath);
    }
    let offset = 0;
    let first = true;
    for (;;) {
      const end = content.indexOf(10, offset);
      if (end === -1) break;
      const record = JSON.parse(content.subarray(offset, end).toString("utf8")) as LogRecord;
      if (first) {
        if (!("snapshot" in record) || record.version !== 1 || record.snapshot.schemaVersion !== 4) throw new Error("Unsupported execution log snapshot.");
        this.apply(record.snapshot);
        first = false;
      } else {
        if (!("transaction" in record)) throw new Error("Invalid execution log transaction.");
        this.apply(record.transaction);
      }
      offset = end + 1;
    }
    if (first) throw new Error("Execution log has no complete snapshot.");
    // Only the unterminated suffix can be a torn append. Never hide an error
    // in a committed line or fall back to stale legacy data after migration.
    if (offset !== content.length) await truncate(this.logPath, offset);
    this.size = offset;
  }

  private apply(change: Transaction): void {
    for (const run of change.runs ?? []) this.runs.set(run.id, run);
    for (const attempt of change.attempts ?? []) this.attempts.set(attempt.id, attempt);
    for (const entry of change.journal ?? []) {
      if (entry.sequence !== this.sequence + 1) throw new Error("Execution journal sequence is not contiguous.");
      this.sequence = entry.sequence;
      const entries = this.journal.get(entry.runId) ?? [];
      entries.push(entry); this.journal.set(entry.runId, entries);
      if (entry.type === "usage") {
        const usage = this.usage.get(entry.runId) ?? [];
        usage.push(entry); this.usage.set(entry.runId, usage);
      }
    }
  }

  /** Publish only after the append and flush succeed; a failed append rolls
   * back to the last committed byte. If rollback fails, reject future writes
   * until restart rather than appending after an uncertain partial record. */
  private async persist(change: Transaction): Promise<void> {
    if (this.poisoned !== undefined) throw this.poisoned;
    const owned = structuredClone(change);
    const bytes = Buffer.from(`${JSON.stringify({ transaction: owned } satisfies LogRecord)}\n`);
    const file = await open(this.logPath, "a", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } catch (error) {
      try { await file.truncate(this.size); await file.sync(); }
      catch (rollback) { this.poisoned = rollback; }
      throw error;
    } finally { await file.close(); }
    this.size += bytes.length;
    this.apply(owned);
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.writes.then(async () => { await this.ready(); return operation(); });
    this.writes = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async recoverInterruptedRuns(observedAt: string): Promise<void> {
    await this.mutate(async () => {
      const runs = [...this.runs.values()];
      const attempts = [...this.attempts.values()];
      // Recovery only needs the final sequence, not every historical payload.
      const tail = this.sequence === 0 ? [] : [{ sequence: this.sequence } as JournalEntry];
      const recovered = recoverExecutionState({ runs, attempts, journal: tail }, observedAt);
      const changedRuns = recovered.runs.filter((run, index) => run !== runs[index]);
      const changedAttempts = recovered.attempts.filter((attempt, index) => attempt !== attempts[index]);
      const journal = recovered.journal.slice(tail.length);
      if (changedRuns.length || changedAttempts.length || journal.length) await this.persist({ runs: changedRuns, attempts: changedAttempts, journal });
    });
  }

  async getRun(id: RunId): Promise<RunRecord | undefined> { await this.ready(); return structuredClone(this.runs.get(id)); }
  async listRuns(sessionId: string): Promise<readonly RunRecord[]> {
    await this.ready(); return structuredClone([...this.runs.values()].filter((run) => run.sessionId === sessionId));
  }
  saveRun(run: RunRecord): Promise<void> { return this.mutate(() => this.persist({ runs: [run] })); }
  async getAttempt(id: AttemptId): Promise<AttemptRecord | undefined> { await this.ready(); return structuredClone(this.attempts.get(id)); }
  saveAttempt(attempt: AttemptRecord): Promise<void> { return this.mutate(() => this.persist({ attempts: [attempt] })); }
  appendJournal(entry: Omit<JournalEntry, "sequence">): Promise<JournalEntry> {
    return this.mutate(async () => {
      const stored = { ...entry, sequence: this.sequence + 1 };
      await this.persist({ journal: [stored] }); return structuredClone(stored);
    });
  }
  async listJournal(runId: RunId): Promise<readonly JournalEntry[]> { await this.ready(); return structuredClone(this.journal.get(runId) ?? []); }
  async listRunUsage(): Promise<readonly RunUsage[]> {
    await this.ready();
    return structuredClone([...this.runs.values()].map((run) => ({
      run: { id: run.id, ...(run.projectId === undefined ? {} : { projectId: run.projectId }), providerId: run.providerId,
        status: run.status, createdAt: run.createdAt, ...(run.model === undefined ? {} : { model: run.model }) },
      usage: this.usage.get(run.id) ?? [],
    })));
  }
}
