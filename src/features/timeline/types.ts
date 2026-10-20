/**
 * Timeline domain records.
 *
 * Timeline is an optional, first-party feature (see docs/timeline.md). It
 * records observed repository states during desktop-managed runs as Git
 * objects reachable from a hidden per-session ref, and keeps a small index of
 * those states ("checkpoints") in its own store. Core sessions and execution
 * never read these records; disabling or removing Timeline does not affect
 * continuity or recovery.
 *
 * Terminology follows the product specification:
 * - snapshot: a Git commit object whose tree is the captured repository state;
 * - checkpoint: an indexed reference to a snapshot, its preceding snapshot,
 *   and the paths that changed between them;
 * - baseline: the first snapshot of a session chain. It has no predecessor
 *   and establishes comparison context rather than presenting every file as
 *   a change, so it never appears as a visible checkpoint.
 */

/** Git's own change letters, reduced to the states Timeline displays. */
export type TimelineChangeStatus = "added" | "modified" | "deleted" | "type_changed";

/** One path that differs between a checkpoint and its preceding snapshot. */
export interface TimelineChangedPath {
  /** Repository-root-relative path using forward slashes. */
  readonly path: string;
  readonly status: TimelineChangeStatus;
}

/**
 * Structural role of a snapshot.
 *
 * Baseline-ness is decided by structure (no predecessor), never by label.
 * This resolves the specification's open question about run-start captures:
 * a later run's first observation keeps any between-run changes as an
 * ordinary checkpoint, both live and after recovery from refs.
 */
export type TimelineCheckpointKind = "baseline" | "checkpoint";

/** How the checkpoint entered the index. */
export type TimelineCheckpointSource = "recorded" | "imported";

export interface TimelineCheckpoint {
  /** Stable index identity; currently `checkpoint:<snapshot hash>`. */
  readonly id: string;
  readonly sessionId: string;
  readonly kind: TimelineCheckpointKind;
  /** Full hash of the snapshot commit. */
  readonly snapshot: string;
  /** Full hash of the preceding snapshot; absent for a baseline. */
  readonly previous?: string;
  /** Observation label, for example `After Edit`. Not an authorship claim. */
  readonly label: string;
  /** Run that was active when the snapshot was observed, if any. */
  readonly runId?: string;
  /** Tool call associated with a tool-boundary observation, if any. */
  readonly toolCallId?: string;
  /**
   * Every path that differs from the preceding snapshot, unfiltered. Display
   * exclusions and ignore rules are applied at query time with the current
   * rules, as the specification requires.
   */
  readonly changedPaths: readonly TimelineChangedPath[];
  readonly source: TimelineCheckpointSource;
  /** Snapshot time (ISO 8601). */
  readonly createdAt: string;
}

/** Persisted per-session Timeline settings and checkpoint index. */
export interface TimelineSessionState {
  readonly sessionId: string;
  /** Opt-in for this session only; new sessions start disabled. */
  readonly enabled: boolean;
  /** True when the last import reached the bounded record limit. */
  readonly importTruncated: boolean;
  /** Ordered by `createdAt`, oldest first. */
  readonly checkpoints: readonly TimelineCheckpoint[];
  readonly updatedAt: string;
}

/** Project observation defaults on; an explicit pause survives application restarts. */
export interface TimelineProjectState {
  readonly projectId: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
}

/** Result of probing whether a project folder can host Timeline snapshots. */
export type TimelineCapability =
  | { readonly supported: true; readonly repositoryRoot: string }
  | { readonly supported: false; readonly reason: string };

/** Session-level availability and settings, as presented to clients. */
export interface TimelineStatus {
  readonly sessionId: string;
  readonly supported: boolean;
  /** Present when unsupported. */
  readonly reason?: string;
  readonly enabled: boolean;
  readonly importTruncated: boolean;
  /**
   * Message from the most recent failed capture in this project during the
   * current application lifetime. Capture is retried on the next run.
   */
  readonly captureError?: string;
}

/** A checkpoint with display filtering applied, ready for presentation. */
export interface TimelineCheckpointEntry {
  readonly id: string;
  /** One-based position among all visible checkpoints of the session. */
  readonly position: number;
  readonly label: string;
  readonly createdAt: string;
  readonly source: TimelineCheckpointSource;
  readonly runId?: string;
  readonly toolCallId?: string;
  /** Visible changed paths; never empty for a listed checkpoint. */
  readonly files: readonly TimelineChangedPath[];
}

export interface TimelineCheckpointList {
  readonly status: TimelineStatus;
  /** Oldest first. Empty unless Timeline is supported and enabled. */
  readonly checkpoints: readonly TimelineCheckpointEntry[];
}

/** Repository history is read-only and never assigned to the selected session. */
export interface TimelineProjectHistoryEntry extends Omit<TimelineCheckpointEntry, "source"> {
  readonly source: TimelineCheckpointSource | "git";
  readonly snapshot: string;
  readonly parents?: readonly string[];
  /** Names of local/remote branch tips at this commit; not containment claims. */
  readonly branches?: readonly string[];
  /** Present only when the original recorder included a session association. */
  readonly sessionId?: string;
}

/** Existing commits and saved session snapshots; available without recording opt-in. */
export interface TimelineProjectHistory {
  readonly projectId: string;
  readonly supported: boolean;
  readonly reason?: string;
  readonly truncated: boolean;
  readonly recording: boolean;
  readonly captureError?: string;
  /** Oldest first, deduplicated by commit hash. */
  readonly checkpoints: readonly TimelineProjectHistoryEntry[];
}

/** A checkpoint selected through either public history view; never a raw revision. */
export interface TimelineSnapshotTarget {
  readonly scope: "project" | "session";
  readonly contextId: string;
  readonly checkpointId: string;
}

/** A selectable comparison from the same project as an expanded snapshot. */
export interface TimelineSnapshotChoice {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly source: TimelineCheckpointSource | "git";
  readonly target: TimelineSnapshotTarget;
}

export interface TimelineSnapshotHistory {
  /** Newest first; the initially opened snapshot is retained when outside the recent page. */
  readonly entries: readonly TimelineSnapshotChoice[];
  readonly truncated: boolean;
}

/** File membership on both sides of one historical comparison. */
export interface TimelineSnapshotFile {
  readonly path: string;
  readonly before: boolean;
  readonly after: boolean;
  /** Absent for unchanged files, which are available through All files. */
  readonly status?: TimelineChangeStatus;
}

/** Read-only snapshot metadata and the full visible before/after file union. */
export interface TimelineSnapshot {
  readonly id: string;
  readonly snapshot: string;
  readonly previous?: string;
  readonly label: string;
  readonly createdAt: string;
  readonly files: readonly TimelineSnapshotFile[];
}

/** Exact historical blob text. Binary, oversized and non-file objects carry a notice. */
export interface TimelineFileContent {
  readonly text: string;
  readonly truncated: boolean;
  readonly notice?: string;
}

/** All display modes read immutable Git objects, never the live working files. */
export interface TimelineSnapshotFileView {
  readonly path: string;
  readonly before?: TimelineFileContent;
  readonly after?: TimelineFileContent;
  readonly diff: string;
  readonly diffTruncated: boolean;
  readonly status?: TimelineChangeStatus;
}

/** One file's patch between a checkpoint and its preceding snapshot. */
export interface TimelineFileDiff {
  readonly checkpointId: string;
  readonly path: string;
  readonly status: TimelineChangeStatus;
  /** Unified Git patch for this path; may be shortened (see `truncated`). */
  readonly diff: string;
  readonly truncated: boolean;
  /** Explanation when no text diff is available, for example binary data. */
  readonly notice?: string;
}
