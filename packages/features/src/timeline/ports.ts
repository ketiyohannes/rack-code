/**
 * Integration contracts owned by the Timeline feature.
 *
 * Timeline rules stay independent of Git process handling, filesystem
 * watching, and storage formats. Startup composition supplies concrete
 * adapters (`@rack/node-adapters` timeline and storage); tests supply fakes or
 * real Git repositories in temporary folders.
 */
import type {
  TimelineCapability,
  TimelineChangedPath,
  TimelineSessionState,
  TimelineFileContent,
  TimelineProjectState,
} from "./types.js";

/** Durable per-session Timeline state. */
export interface TimelineStore {
  getProject(projectId: string): Promise<TimelineProjectState | undefined>;
  saveProject(state: TimelineProjectState): Promise<void>;
  get(sessionId: string): Promise<TimelineSessionState | undefined>;
  /** Applies `change` atomically with respect to other updates of any session. */
  update(
    sessionId: string,
    change: (current: TimelineSessionState | undefined) => TimelineSessionState,
  ): Promise<TimelineSessionState>;
}

/** Input for one snapshot capture. */
export interface SnapshotCaptureInput {
  /** Project folder; the snapshot covers its whole repository. */
  readonly projectPath: string;
  /** Hidden ref advanced by this capture, e.g. `refs/rack-timeline/<id>`. */
  readonly ref: string;
  readonly label: string;
  /** Structured metadata recorded as commit-message trailers. */
  readonly trailers: Readonly<Record<string, string>>;
  /** A new project chain compares its first observed edits to HEAD when available. */
  readonly startFromHead?: boolean;
}

/** Outcome of a capture. */
export type SnapshotCaptureResult =
  /** The working tree matches the current ref tip; nothing was written. */
  | { readonly kind: "unchanged"; readonly snapshot: string }
  | {
      readonly kind: "created";
      readonly snapshot: string;
      /** Previous ref tip; absent when this is the chain's first snapshot. */
      readonly previous?: string;
      /** Every path changed since `previous`; empty for a first snapshot. */
      readonly changedPaths: readonly TimelineChangedPath[];
      readonly createdAt: string;
    };

/** One commit read from a timeline ref, oldest first in returned lists. */
export interface SnapshotRecord {
  readonly snapshot: string;
  /** All Git parents and branch tips for the repository-wide view. */
  readonly parents?: readonly string[];
  readonly branches?: readonly string[];
  /** First parent only; Timeline chains are first-parent histories. */
  readonly previous?: string;
  readonly createdAt: string;
  readonly label: string;
  readonly runId?: string;
  readonly toolCallId?: string;
  /** Original session association, when the snapshot commit records one. */
  readonly sessionId?: string;
  readonly projectId?: string;
  /**
   * Who wrote the commit:
   * - `rack`: Rack's session/project recorder (author identity and trailers);
   * - `external`: a recognized external timeline format (Relay or Codex
   *   timeline commits whose subject starts with `timeline:`);
   * - `other`: an ordinary commit, which import never treats as a checkpoint.
   */
  readonly format: "rack" | "external" | "other";
}

export interface SnapshotHistory {
  readonly records: readonly SnapshotRecord[];
  /** True when the bounded read reached its limit. */
  readonly truncated: boolean;
}

/** Patch text for one path between two snapshots. */
export interface SnapshotPatch {
  readonly diff: string;
  readonly truncated: boolean;
  readonly binary: boolean;
}

/**
 * Git-backed snapshot storage.
 *
 * Implementations must never change the user's HEAD, branch, index, or
 * working files. They may write Git objects and the named hidden refs.
 */
export interface SnapshotRepository {
  /** Missing folders, non-Git folders, and missing Git are unsupported states, not errors. */
  probe(projectPath: string): Promise<TimelineCapability>;
  capture(input: SnapshotCaptureInput): Promise<SnapshotCaptureResult>;
  /** Names among `refs` that currently exist, preserving input order. */
  existingRefs(projectPath: string, refs: readonly string[]): Promise<readonly string[]>;
  /** Bounded first-parent history reachable from `refs`. */
  history(projectPath: string, refs: readonly string[], limit: number): Promise<SnapshotHistory>;
  /** HEAD first-parent history by default; all follows every parent of local/remote
   * branches plus supported Timeline refs, in bounded topological order. */
  projectHistory(projectPath: string, limit: number, mode?: "current" | "all"): Promise<SnapshotHistory>;
  /** An absent predecessor compares a root commit against an empty tree. */
  changedPaths(projectPath: string, previous: string | undefined, snapshot: string): Promise<readonly TimelineChangedPath[]>;
  /**
   * Returns the subset of repository-relative `paths` that Timeline displays:
   * display exclusions plus current Git ignore rules (nested rules, negations,
   * and global excludes). Order is preserved.
   */
  visiblePaths(projectPath: string, paths: readonly string[]): Promise<readonly string[]>;
  patch(projectPath: string, previous: string | undefined, snapshot: string, path: string): Promise<SnapshotPatch>;
  /** Repository-relative leaf paths in an immutable tree, including non-file objects. */
  tree(projectPath: string, snapshot: string): Promise<readonly string[]>;
  /** Reads a literal tree member without checking out or following a symlink. */
  content(projectPath: string, snapshot: string, path: string): Promise<TimelineFileContent>;
}

/** A started filesystem watch; `close` is idempotent. */
export interface WatchHandle {
  /** A watcher that ends unexpectedly can fall back to periodic observations. */
  readonly closed?: boolean;
  close(): void;
}

/**
 * Recursive filesystem change notifications for a project's repository.
 *
 * Returning `undefined` means recursive watching is unavailable on this
 * platform or for this folder; tool and run boundary capture still applies.
 * Implementations should already drop events inside `.git` so Timeline's own
 * ref updates cannot trigger further observations.
 */
export interface ProjectWatcher {
  watch(repositoryRoot: string, onChange: () => void): WatchHandle | undefined;
}

/**
 * Narrow reads from core capabilities. Timeline consumes core records through
 * public services only; composition adapts those services to this shape.
 */
export interface TimelineCoreAccess {
  /** Saved project folders observed while the desktop execution host is alive. */
  projects(): Promise<readonly { readonly projectId: string; readonly projectPath: string }[]>;
  /** Resolves an existing project even when no session is selected. */
  project(projectId: string): Promise<{ readonly projectPath: string }>;
  /** Resolves a session's project folder and import provenance. */
  session(sessionId: string): Promise<{
    readonly sessionId: string;
    readonly projectId: string;
    readonly projectPath: string;
    /** Native Codex session ID for sessions imported from local Codex history. */
    readonly importedCodexSessionId?: string;
  }>;
  /** True while the named session has an app-managed writer. Omitting the
   * session checks the project; older embedders may conservatively do that. */
  projectBusy(projectId: string, sessionId?: string): Promise<boolean>;
}
