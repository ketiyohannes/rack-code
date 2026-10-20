/**
 * Timeline feature service: per-session opt-in, history import, checkpoint
 * listing, read-only existing project history, per-file diffs, and run capture.
 *
 * Responsibilities and boundaries
 * - Owns the Timeline store and the hidden `refs/rack-timeline/<session ID>`
 *   chain. Snapshot contents live in the project's Git object database; the
 *   store holds only the enablement flag and the checkpoint index.
 * - Reads project paths, sessions and project lock state through `TimelineCoreAccess` only.
 *   Core sessions and execution never depend on this module.
 * - Never changes the user's HEAD, branch, index, or working files (enforced
 *   by the `SnapshotRepository` contract).
 *
 * Concurrency
 * All operations that read or advance one session's chain (captures,
 * enablement changes, imports) run on a per-session promise queue. Two
 * sessions in the same repository use separate refs and temporary indexes,
 * so they may capture concurrently. This is serialization within one host
 * process, not across unrelated processes.
 *
 * Failure policy
 * Timeline must never prevent a run. `beginRun` swallows every failure and
 * returns `undefined` or a recorder that has already stopped. A failed
 * capture is remembered per repository for the current application lifetime
 * and reported through `status().captureError`; the next run tries again.
 * This deliberately softens the specification's "mark capability
 * unavailable" behavior, which offered no recovery path (spec section 18,
 * recommendation 7).
 */
import { SnapshotNotFoundError, SnapshotPathError, TimelineBusyError, TimelineUnsupportedError } from "./errors.js";
import type { ProjectWatcher, SnapshotRecord, SnapshotRepository, TimelineCoreAccess, TimelineStore } from "./ports.js";
import { RunRecorder, type RecorderEvent } from "./recorder.js";
import { ProjectTimelineTracker } from "./project-tracker.js";
import type {
  TimelineCapability,
  TimelineCheckpoint,
  TimelineCheckpointEntry,
  TimelineCheckpointList,
  TimelineChangedPath,
  TimelineFileDiff,
  TimelineProjectHistory,
  TimelineProjectHistoryEntry,
  TimelineSnapshot,
  TimelineSnapshotTarget,
  TimelineSnapshotFileView,
  TimelineSnapshotHistory,
  TimelineSessionState,
  TimelineStatus,
} from "./types.js";

/** Hidden ref namespace written by Rack. */
export const TIMELINE_REF_PREFIX = "refs/rack-timeline/";
/** Read-only namespace imported for sessions that came from local Codex history. */
export const CODEX_TIMELINE_REF_PREFIX = "refs/codex-timeline/";
/** Bounded first-parent records read per import (specification section 7). */
export const IMPORT_RECORD_LIMIT = 2001;
/** Keep repository-wide reads responsive; older entries are explicitly bounded. */
export const PROJECT_HISTORY_LIMIT = 200;

/**
 * Labels external recorders use for baselines. Rack's own records are
 * classified structurally (no predecessor), so this list only applies to
 * `external` records, matching the specification's import filter.
 */
const EXTERNAL_BASELINE_LABEL = /^(?:session baseline|baseline|existing project baseline)$/i;

/**
 * Characters accepted in a ref component. Session IDs are UUIDs and native
 * Codex IDs are UUID-like; anything else is refused rather than escaped, so
 * a crafted ID can never address another ref or an invalid ref name.
 */
const SAFE_REF_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

/** A run observer handed to the host's run drain. */
export interface TimelineRunObserver {
  /**
   * Associates later captures with the run. The run ID is assigned by
   * execution after the run-start observation, which must precede the run.
   */
  bindRun(runId: string): void;
  /** Feeds one normalized runtime event; never throws. */
  observe(event: RecorderEvent): void;
  /** Records `Run settled` and waits for queued captures. */
  finish(): Promise<void>;
  /** Releases resources without capturing, when the run failed to start. */
  abandon(): void;
}

export interface TimelineServiceOptions {
  readonly watcher?: ProjectWatcher;
  readonly now?: () => Date;
  /** Overrides the watcher debounce, for tests. */
  readonly debounceMs?: number;
}

type ChangeListener = (sessionId: string) => void;

export class TimelineService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly captureErrors = new Map<string, string>();
  private readonly listeners = new Set<ChangeListener>();
  private readonly now: () => Date;
  private readonly projectTracker: ProjectTimelineTracker;
  /** Immutable commit comparisons only; current ignore rules are never cached. */
  private readonly historyPaths = new Map<string, Promise<readonly TimelineChangedPath[]>>();

  constructor(
    private readonly core: TimelineCoreAccess,
    private readonly store: TimelineStore,
    private readonly snapshots: SnapshotRepository,
    private readonly options: TimelineServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.projectTracker = new ProjectTimelineTracker(core, store, snapshots, options.watcher,
      (root, message) => { if (message === undefined) this.captureErrors.delete(root); else this.captureErrors.set(root, message); });
  }

  /** Desktop lifetime only; read-only/headless composition does not start workers. */
  startProjectTracking(): Promise<void> { return this.projectTracker.start(); }
  stopProjectTracking(): Promise<void> { return this.projectTracker.stop(); }
  refreshProjects(): Promise<void> { return this.projectTracker.refresh(); }

  /** Persist an explicit project pause; session opt-in remains independent. */
  async setProjectEnabled(projectId: string, enabled: boolean): Promise<TimelineProjectHistory> {
    await this.core.project(projectId);
    await this.store.saveProject({ projectId, enabled, updatedAt: this.now().toISOString() });
    await this.projectTracker.refresh();
    return this.projectHistory(projectId);
  }

  /**
   * Notifies `listener` with a session ID whenever that session's checkpoints
   * or settings change. Listeners are freshness signals; clients re-read.
   */
  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Capability and settings for one session. Never throws for unsupported projects. */
  async status(sessionId: string): Promise<TimelineStatus> {
    const session = await this.core.session(sessionId);
    const capability = await this.capability(sessionId, session.projectPath);
    const state = await this.store.get(sessionId);
    return this.statusFrom(sessionId, capability, state);
  }

  /**
   * Turns Timeline on or off for one session.
   *
   * Enabling imports eligible checkpoints from the session's exact refs and
   * enables future capture in one operation (the specification's "Import
   * timeline"). Disabling stops capture but keeps the index, Git objects, and
   * refs; re-enabling imports only missing checkpoints.
   *
   * Rejected with `TimelineBusyError` while a run edits the project, checked
   * both before and after the capability probe, and with
   * `TimelineUnsupportedError` when enabling an unsupported project.
   */
  async setEnabled(sessionId: string, enabled: boolean): Promise<TimelineStatus> {
    const session = await this.core.session(sessionId);
    if (await this.core.projectBusy(session.projectId, sessionId)) throw new TimelineBusyError(sessionId);
    return this.serialize(sessionId, async () => {
      const capability = await this.capability(sessionId, session.projectPath);
      // A run may have started while Git was probed.
      if (await this.core.projectBusy(session.projectId, sessionId)) throw new TimelineBusyError(sessionId);
      if (enabled && !capability.supported) throw new TimelineUnsupportedError(capability.reason);
      let imported: { readonly checkpoints: readonly TimelineCheckpoint[]; readonly truncated: boolean } | undefined;
      if (enabled && capability.supported) {
        const existing = await this.store.get(sessionId);
        imported = await this.importHistory(sessionId, session.projectPath, session.importedCodexSessionId, existing?.checkpoints ?? []);
      }
      const state = await this.store.update(sessionId, (current) => {
        const base = current ?? this.emptyState(sessionId);
        return {
          ...base,
          enabled,
          importTruncated: imported?.truncated ?? base.importTruncated,
          checkpoints: imported === undefined ? base.checkpoints : mergeCheckpoints(base.checkpoints, imported.checkpoints),
          updatedAt: this.now().toISOString(),
        };
      });
      this.notify(sessionId);
      return this.statusFrom(sessionId, capability, state);
    });
  }

  /**
   * Visible checkpoints of a session, oldest first. A checkpoint is visible
   * when it has a predecessor and at least one changed path survives display
   * exclusions and the repository's current ignore rules.
   */
  async checkpoints(sessionId: string): Promise<TimelineCheckpointList> {
    const session = await this.core.session(sessionId);
    const capability = await this.capability(sessionId, session.projectPath);
    const state = await this.store.get(sessionId);
    const status = this.statusFrom(sessionId, capability, state);
    if (!capability.supported || state === undefined || !state.enabled) return { status, checkpoints: [] };
    const visible = await this.visibleSet(session.projectPath, state.checkpoints);
    const entries: TimelineCheckpointEntry[] = [];
    for (const checkpoint of state.checkpoints) {
      if (checkpoint.kind !== "checkpoint") continue;
      const files = checkpoint.changedPaths.filter((change) => visible.has(change.path));
      if (files.length === 0) continue;
      entries.push({
        id: checkpoint.id,
        position: entries.length + 1,
        label: checkpoint.label,
        createdAt: checkpoint.createdAt,
        source: checkpoint.source,
        files,
        ...(checkpoint.runId === undefined ? {} : { runId: checkpoint.runId }),
        ...(checkpoint.toolCallId === undefined ? {} : { toolCallId: checkpoint.toolCallId }),
      });
    }
    return { status, checkpoints: entries };
  }

  /**
   * Existing project history, independent of session selection and recording.
   * HEAD commits and saved timeline refs retain their original provenance;
   * reading never imports them into a session or changes its opt-in state.
   */
  async projectHistory(projectId: string, mode: "current" | "all" = "current"): Promise<TimelineProjectHistory> {
    const { projectPath } = await this.core.project(projectId);
    const capability = await this.snapshots.probe(projectPath);
    if (!capability.supported) return { projectId, supported: false, reason: capability.reason, truncated: false, recording: false, checkpoints: [] };
    const history = await this.snapshots.projectHistory(projectPath, PROJECT_HISTORY_LIMIT + 1, mode);
    const records = history.records.slice(-PROJECT_HISTORY_LIMIT).filter(isProjectRecord);
    const candidates: TimelineProjectHistoryEntry[] = [];
    // Repeated refreshes read only the ref tips/history and current ignore
    // rules. Immutable comparisons are reused and coalesced across requests.
    for (const record of records) {
      const files = await this.projectRecordPaths(projectPath, capability.repositoryRoot, record);
      candidates.push({
        id: checkpointId(record.snapshot), position: 0, snapshot: record.snapshot,
        label: record.label, createdAt: record.createdAt, files,
        ...(record.parents ? { parents: record.parents } : {}), ...(record.branches ? { branches: record.branches } : {}),
        source: record.format === "other" ? "git" : record.format === "rack" ? "recorded" : "imported",
        ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
        ...(record.runId === undefined ? {} : { runId: record.runId }),
        ...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
      });
    }
    const visible = new Set(await this.snapshots.visiblePaths(projectPath, [...new Set(candidates.flatMap((entry) => entry.files.map((file) => file.path)))]));
    const checkpoints = candidates.map((entry) => ({ ...entry, files: entry.files.filter((file) => visible.has(file.path)) }))
      .filter((entry) => entry.files.length > 0 || (mode === "all" && entry.source === "git"))
      // All-branch pages retain Git topology. In the current-branch view,
      // equal one-second timestamps keep each chain stable and place saved
      // observations after ordinary commits.
      .sort((a, b) => mode === "all" ? 0 : a.createdAt.localeCompare(b.createdAt) || Number(a.source !== "git") - Number(b.source !== "git"))
      .map((entry, index) => ({ ...entry, position: index + 1 }));
    return { projectId, supported: true, recording: (await this.store.getProject(projectId))?.enabled !== false,
      ...(this.captureErrors.get(capability.repositoryRoot) === undefined ? {} : { captureError: this.captureErrors.get(capability.repositoryRoot)! }),
      truncated: history.truncated || history.records.length > PROJECT_HISTORY_LIMIT, checkpoints };
  }

  /**
   * Only commits still reachable from this project's allowed history and
   * currently visible changed paths may be previewed. Client IDs never become
   * Git revisions, and history from a different repository is rejected.
   */
  async projectFileDiff(projectId: string, id: string, path: string): Promise<TimelineFileDiff> {
    const { projectPath } = await this.core.project(projectId);
    const capability = await this.snapshots.probe(projectPath);
    if (!capability.supported) throw new TimelineUnsupportedError(capability.reason);
    const history = await this.snapshots.projectHistory(projectPath, PROJECT_HISTORY_LIMIT + 1, "all");
    const record = history.records.slice(-PROJECT_HISTORY_LIMIT).find((entry) => checkpointId(entry.snapshot) === id && isProjectRecord(entry))
      ?? (await this.snapshots.projectHistory(projectPath, PROJECT_HISTORY_LIMIT + 1)).records.slice(-PROJECT_HISTORY_LIMIT).find(entry => checkpointId(entry.snapshot) === id && isProjectRecord(entry));
    if (record === undefined) throw new SnapshotNotFoundError(id);
    const files = await this.projectRecordPaths(projectPath, capability.repositoryRoot, record);
    const change = files.find((file) => file.path === path);
    if (change === undefined || !(await this.snapshots.visiblePaths(projectPath, [path])).includes(path)) throw new SnapshotPathError(path);
    const patch = await this.snapshots.patch(projectPath, record.previous, record.snapshot, path);
    const notice = patch.binary ? "Binary file; no text preview."
      : !/^@@ /m.test(patch.diff) ? "No text changes in this file." : undefined;
    return { checkpointId: id, path, status: change.status, diff: patch.diff, truncated: patch.truncated,
      ...(notice === undefined ? {} : { notice }) };
  }

  /**
   * Full visible file union for a historical comparison. Deleted paths remain
   * selectable, and unchanged files are included without a change status.
   * Membership is resolved through the same project/session rules as previews.
   */
  async snapshot(target: TimelineSnapshotTarget): Promise<TimelineSnapshot> {
    const { projectPath, record, changes } = await this.snapshotContext(target);
    const [before, after] = await Promise.all([
      record.previous === undefined ? Promise.resolve([] as readonly string[]) : this.snapshots.tree(projectPath, record.previous),
      this.snapshots.tree(projectPath, record.snapshot),
    ]);
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const changed = new Map(changes.map((change) => [change.path, change.status]));
    const paths = await this.snapshots.visiblePaths(projectPath, [...new Set([...before, ...after])]);
    return {
      id: target.checkpointId, snapshot: record.snapshot, label: record.label, createdAt: record.createdAt,
      ...(record.previous === undefined ? {} : { previous: record.previous }),
      files: [...paths].sort((a, b) => a.localeCompare(b)).map((path) => ({
        path, before: beforeSet.has(path), after: afterSet.has(path),
        ...(changed.has(path) ? { status: changed.get(path)! } : {}),
      })),
    };
  }

  /**
   * Navigation for an expanded window spans its project's commits and saved
   * observations, even if opened from This session. The initial session
   * checkpoint remains selectable when it falls outside the recent page.
   */
  async snapshotHistory(target: TimelineSnapshotTarget): Promise<TimelineSnapshotHistory> {
    const original = await this.snapshotContext(target);
    const projectId = target.scope === "project" ? target.contextId : (await this.core.session(target.contextId)).projectId;
    const history = await this.projectHistory(projectId, "all");
    const entries = history.checkpoints.map((entry) => ({
      id: entry.id, label: entry.label, createdAt: entry.createdAt, source: entry.source,
      target: entry.id === target.checkpointId ? target : { scope: "project" as const, contextId: projectId, checkpointId: entry.id },
    }));
    if (!entries.some((entry) => entry.id === target.checkpointId)) entries.push({
      id: target.checkpointId, label: original.record.label, createdAt: original.record.createdAt,
      source: "recorded", target,
    });
    return { entries: entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), truncated: history.truncated };
  }

  /**
   * Exact before/after contents and a bounded diff for a tree member. All files
   * uses tree membership rather than permitting arbitrary repository paths.
   * No checkout, working-file read, or recording preference change occurs.
   */
  async snapshotFile(target: TimelineSnapshotTarget, path: string): Promise<TimelineSnapshotFileView> {
    const view = await this.snapshot(target);
    const file = view.files.find((entry) => entry.path === path);
    if (file === undefined) throw new SnapshotPathError(path);
    const projectPath = target.scope === "project" ? (await this.core.project(target.contextId)).projectPath
      : (await this.core.session(target.contextId)).projectPath;
    const [before, after] = await Promise.all([
      file.before && view.previous !== undefined ? this.snapshots.content(projectPath, view.previous, path) : undefined,
      file.after ? this.snapshots.content(projectPath, view.snapshot, path) : undefined,
    ]);
    // Do not generate an enormous patch for contents already above the read
    // limit. The viewer can report the size notice and keep the tree usable.
    const oversized = before?.truncated === true || after?.truncated === true;
    const patch = file.status === undefined || oversized ? undefined : await this.snapshots.patch(projectPath, view.previous, view.snapshot, path);
    return { path, diff: patch?.diff ?? "", diffTruncated: oversized || (patch?.truncated ?? false),
      ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }),
      ...(file.status === undefined ? {} : { status: file.status }) };
  }

  /** Resolves app identities to trusted immutable revisions before any tree read. */
  private async snapshotContext(target: TimelineSnapshotTarget): Promise<{
    readonly projectPath: string;
    readonly record: Pick<SnapshotRecord, "snapshot" | "previous" | "label" | "createdAt">;
    readonly changes: readonly TimelineChangedPath[];
  }> {
    if (target.scope === "session") {
      const session = await this.core.session(target.contextId);
      const state = await this.store.get(target.contextId);
      const record = state?.enabled ? state.checkpoints.find((entry) => entry.id === target.checkpointId && entry.kind === "checkpoint") : undefined;
      if (record === undefined) throw new SnapshotNotFoundError(target.checkpointId);
      return { projectPath: session.projectPath, record, changes: record.changedPaths };
    }
    const { projectPath } = await this.core.project(target.contextId);
    const capability = await this.snapshots.probe(projectPath);
    if (!capability.supported) throw new TimelineUnsupportedError(capability.reason);
    const history = await this.snapshots.projectHistory(projectPath, PROJECT_HISTORY_LIMIT + 1, "all");
    const record = history.records.slice(-PROJECT_HISTORY_LIMIT).find((entry) => checkpointId(entry.snapshot) === target.checkpointId && isProjectRecord(entry))
      ?? (await this.snapshots.projectHistory(projectPath, PROJECT_HISTORY_LIMIT + 1)).records.slice(-PROJECT_HISTORY_LIMIT).find(entry => checkpointId(entry.snapshot) === target.checkpointId && isProjectRecord(entry));
    if (record === undefined) throw new SnapshotNotFoundError(target.checkpointId);
    return { projectPath, record, changes: await this.projectRecordPaths(projectPath, capability.repositoryRoot, record) };
  }

  /** Bounded cache of immutable comparisons, keyed by repository and commit. */
  private projectRecordPaths(projectPath: string, root: string, record: SnapshotRecord): Promise<readonly TimelineChangedPath[]> {
    const key = `${root}\0${record.snapshot}`;
    const cached = this.historyPaths.get(key);
    if (cached !== undefined) {
      this.historyPaths.delete(key);
      this.historyPaths.set(key, cached);
      return cached;
    }
    const pending = this.snapshots.changedPaths(projectPath, record.previous, record.snapshot);
    this.historyPaths.set(key, pending);
    if (this.historyPaths.size > PROJECT_HISTORY_LIMIT * 2) this.historyPaths.delete(this.historyPaths.keys().next().value!);
    void pending.catch(() => { if (this.historyPaths.get(key) === pending) this.historyPaths.delete(key); });
    return pending;
  }

  /**
   * Patch for one visible changed path of a checkpoint. Only IDs and paths
   * already in the index reach Git; client strings are never used as
   * revisions or unvalidated paths.
   */
  async fileDiff(sessionId: string, checkpointId: string, path: string): Promise<TimelineFileDiff> {
    const session = await this.core.session(sessionId);
    const state = await this.store.get(sessionId);
    const checkpoint = state?.enabled
      ? state.checkpoints.find((candidate) => candidate.id === checkpointId && candidate.kind === "checkpoint")
      : undefined;
    if (checkpoint === undefined || checkpoint.previous === undefined) throw new SnapshotNotFoundError(checkpointId);
    const change = checkpoint.changedPaths.find((candidate) => candidate.path === path);
    if (change === undefined || !(await this.snapshots.visiblePaths(session.projectPath, [path])).includes(path)) {
      throw new SnapshotPathError(path);
    }
    const patch = await this.snapshots.patch(session.projectPath, checkpoint.previous, checkpoint.snapshot, path);
    const notice = patch.binary
      ? "Binary file; no text preview."
      : patch.diff.trim() === "" || !/^@@ /m.test(patch.diff)
        ? "No text changes in this file."
        : undefined;
    return {
      checkpointId,
      path,
      status: change.status,
      diff: patch.diff,
      truncated: patch.truncated,
      ...(notice === undefined ? {} : { notice }),
    };
  }

  /**
   * Prepares capture for a run that is about to start.
   *
   * When the session has Timeline enabled and its project is supported, this
   * captures the run-start observation (labelled `Session baseline` for a
   * chain's first snapshot, otherwise `Run started`) before returning, then
   * starts the filesystem watcher. The caller starts the run afterwards and
   * passes its ID to `bindRun`. Returns `undefined` when Timeline is off or
   * unsupported, or when the run-start capture failed (the failure is then
   * reported through `status().captureError`). Never rejects: Timeline
   * problems must not block a run.
   */
  async beginRun(input: { readonly sessionId: string }): Promise<TimelineRunObserver | undefined> {
    try {
      const session = await this.core.session(input.sessionId);
      return await this.serialize(input.sessionId, async () => {
        const state = await this.store.get(input.sessionId);
        if (state === undefined || !state.enabled) return undefined;
        const capability = await this.capability(input.sessionId, session.projectPath);
        if (!capability.supported) return undefined;
        const root = capability.repositoryRoot;
        const ref = refFor(input.sessionId);
        let failed = false;
        let runId: string | undefined;
        const onFailure = (message: string) => {
          failed = true;
          this.captureErrors.set(root, message);
          this.notify(input.sessionId);
        };
        try {
          const hasChain = (await this.snapshots.existingRefs(session.projectPath, [ref])).length > 0;
          await this.captureUnlocked(input.sessionId, session.projectPath, root, hasChain ? "Run started" : "Session baseline", {});
        } catch (error) {
          onFailure(error instanceof Error ? error.message : String(error));
        }
        if (failed) return undefined;
        const watcher = this.options.watcher;
        const recorder = new RunRecorder({
          capture: (label, metadata) => this.capture(input.sessionId, session.projectPath, root, label, {
            ...(runId === undefined ? {} : { runId }),
            ...metadata,
          }),
          onFailure,
          ...(watcher === undefined ? {} : { startWatch: (onChange: () => void) => watcher.watch(root, onChange) }),
          ...(this.options.debounceMs === undefined ? {} : { debounceMs: this.options.debounceMs }),
        });
        return {
          bindRun: (id) => { runId = id; },
          observe: (event) => recorder.observe(event),
          finish: () => recorder.finish(),
          abandon: () => recorder.abandon(),
        } satisfies TimelineRunObserver;
      });
    } catch {
      return undefined;
    }
  }

  /** Serialized capture used by run recorders. */
  private capture(sessionId: string, projectPath: string, root: string, label: string, metadata: CaptureMetadata): Promise<void> {
    return this.serialize(sessionId, () => this.captureUnlocked(sessionId, projectPath, root, label, metadata));
  }

  /**
   * Captures one snapshot and indexes it. Must run inside the session queue.
   * An unchanged tree creates neither a snapshot nor a checkpoint. A
   * successful capture clears any remembered failure for the repository.
   */
  private async captureUnlocked(
    sessionId: string,
    projectPath: string,
    repositoryRoot: string,
    label: string,
    metadata: CaptureMetadata,
  ): Promise<void> {
    const trailers: Record<string, string> = { "Rack-Timeline-Session": sessionId };
    if (metadata.runId !== undefined) trailers["Rack-Timeline-Run"] = metadata.runId;
    if (metadata.toolCallId !== undefined) trailers["Rack-Timeline-Tool-Call"] = metadata.toolCallId;
    const result = await this.snapshots.capture({ projectPath, ref: refFor(sessionId), label, trailers });
    this.captureErrors.delete(repositoryRoot);
    if (result.kind === "unchanged") return;
    const checkpoint: TimelineCheckpoint = {
      id: checkpointId(result.snapshot),
      sessionId,
      kind: result.previous === undefined ? "baseline" : "checkpoint",
      snapshot: result.snapshot,
      label,
      changedPaths: result.changedPaths,
      source: "recorded",
      createdAt: result.createdAt,
      ...(result.previous === undefined ? {} : { previous: result.previous }),
      ...(metadata.runId === undefined ? {} : { runId: metadata.runId }),
      ...(metadata.toolCallId === undefined ? {} : { toolCallId: metadata.toolCallId }),
    };
    await this.store.update(sessionId, (current) => {
      const base = current ?? this.emptyState(sessionId);
      return { ...base, checkpoints: mergeCheckpoints(base.checkpoints, [checkpoint]), updatedAt: this.now().toISOString() };
    });
    this.notify(sessionId);
  }

  /**
   * Reads exact-identity refs and returns eligible checkpoints not already
   * indexed. Eligible records are recognized timeline commits with a
   * predecessor, not external baselines, with at least one visible change.
   * Similarly prefixed refs, other sessions, and ordinary commits are never
   * fallback sources.
   */
  private async importHistory(
    sessionId: string,
    projectPath: string,
    codexSessionId: string | undefined,
    existing: readonly TimelineCheckpoint[],
  ): Promise<{ readonly checkpoints: readonly TimelineCheckpoint[]; readonly truncated: boolean }> {
    const wanted = [refFor(sessionId)];
    if (codexSessionId !== undefined && SAFE_REF_COMPONENT.test(codexSessionId)) wanted.push(`${CODEX_TIMELINE_REF_PREFIX}${codexSessionId}`);
    const refs = await this.snapshots.existingRefs(projectPath, wanted);
    if (refs.length === 0) return { checkpoints: [], truncated: false };
    const history = await this.snapshots.history(projectPath, refs, IMPORT_RECORD_LIMIT);
    const known = new Set(existing.map((checkpoint) => checkpoint.snapshot));
    const candidates = history.records.filter((record): record is SnapshotRecord & { readonly previous: string } =>
      record.format !== "other" && record.previous !== undefined && !known.has(record.snapshot)
      && !(record.format === "external" && EXTERNAL_BASELINE_LABEL.test(record.label)));
    const withPaths: TimelineCheckpoint[] = [];
    for (const record of candidates) {
      known.add(record.snapshot);
      withPaths.push({
        id: checkpointId(record.snapshot),
        sessionId,
        kind: "checkpoint",
        snapshot: record.snapshot,
        previous: record.previous,
        label: record.label,
        changedPaths: await this.snapshots.changedPaths(projectPath, record.previous, record.snapshot),
        source: "imported",
        createdAt: record.createdAt,
        ...(record.runId === undefined ? {} : { runId: record.runId }),
        ...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
      });
    }
    const visible = await this.visibleSet(projectPath, withPaths);
    return {
      checkpoints: withPaths.filter((checkpoint) => checkpoint.changedPaths.some((change) => visible.has(change.path))),
      truncated: history.truncated,
    };
  }

  /** One ignore-rule query for every distinct changed path. */
  private async visibleSet(projectPath: string, checkpoints: readonly TimelineCheckpoint[]): Promise<ReadonlySet<string>> {
    const paths = [...new Set(checkpoints.flatMap((checkpoint) => checkpoint.changedPaths.map((change) => change.path)))];
    return new Set(paths.length === 0 ? [] : await this.snapshots.visiblePaths(projectPath, paths));
  }

  private async capability(sessionId: string, projectPath: string): Promise<TimelineCapability> {
    if (!SAFE_REF_COMPONENT.test(sessionId)) {
      return { supported: false, reason: "Timeline is not supported for this session." };
    }
    return this.snapshots.probe(projectPath);
  }

  private statusFrom(sessionId: string, capability: TimelineCapability, state: TimelineSessionState | undefined): TimelineStatus {
    const captureError = capability.supported ? this.captureErrors.get(capability.repositoryRoot) : undefined;
    return {
      sessionId,
      supported: capability.supported,
      enabled: state?.enabled ?? false,
      importTruncated: state?.importTruncated ?? false,
      ...(capability.supported ? {} : { reason: capability.reason }),
      ...(captureError === undefined ? {} : { captureError }),
    };
  }

  private emptyState(sessionId: string): TimelineSessionState {
    return { sessionId, enabled: false, importTruncated: false, checkpoints: [], updatedAt: this.now().toISOString() };
  }

  /** Runs `operation` after every earlier operation for the same session settles. */
  private serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const settled = next.then(() => undefined, () => undefined);
    this.queues.set(sessionId, settled);
    // Drop the entry once idle so long-lived hosts do not retain every session.
    void settled.then(() => {
      if (this.queues.get(sessionId) === settled) this.queues.delete(sessionId);
    });
    return next;
  }

  private notify(sessionId: string): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(sessionId);
      } catch {
        // Observers are optional; a failing listener cannot affect capture.
      }
    }
  }
}

interface CaptureMetadata {
  readonly runId?: string;
  readonly toolCallId?: string;
}

/** Hidden ref for a session's Rack chain. Callers validate the ID first. */
export function refFor(sessionId: string): string {
  return `${TIMELINE_REF_PREFIX}${sessionId}`;
}

function checkpointId(snapshot: string): string {
  return `checkpoint:${snapshot}`;
}

/** Ordinary root commits show added files; snapshot baselines remain structural. */
function isProjectRecord(record: SnapshotRecord): boolean {
  return record.format === "other" || (record.previous !== undefined &&
    !(record.format === "external" && EXTERNAL_BASELINE_LABEL.test(record.label)));
}

/**
 * Adds checkpoints whose snapshot is not yet indexed and keeps the index
 * ordered by time. The sort is stable, so equal timestamps keep chain order.
 */
function mergeCheckpoints(current: readonly TimelineCheckpoint[], added: readonly TimelineCheckpoint[]): readonly TimelineCheckpoint[] {
  const known = new Set(current.map((checkpoint) => checkpoint.snapshot));
  const merged = [...current];
  for (const checkpoint of added) {
    if (known.has(checkpoint.snapshot)) continue;
    known.add(checkpoint.snapshot);
    merged.push(checkpoint);
  }
  return merged
    .map((checkpoint, index) => ({ checkpoint, index }))
    .sort((left, right) => left.checkpoint.createdAt.localeCompare(right.checkpoint.createdAt) || left.index - right.index)
    .map((entry) => entry.checkpoint);
}
