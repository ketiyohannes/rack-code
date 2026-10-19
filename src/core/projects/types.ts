export type ProjectId = string;

/** Paths are relative to the workspace; '.' keeps an existing subfolder scope. */
export interface ProjectRepositories {
  readonly selectedPath?: string;
  readonly paths: readonly string[];
  readonly limited: boolean;
  readonly warnings: readonly string[];
}

export interface RepositoryDiscoveryOptions {
  readonly rescan?: boolean;
  readonly deep?: boolean;
  /** Explicit folder selection, still constrained to the workspace. */
  readonly repositoryPath?: string;
}

/** Read-only working-tree snapshot; includes user changes, not just agent edits. */
export interface ProjectChanges {
  readonly status: "ready" | "not_git" | "unavailable";
  readonly diff: string;
  readonly truncated: boolean;
  /** Current branch label; detached checkouts use their short revision. */
  readonly branch?: string;
  /** Separate index/working-tree entries; one path may occur in both groups. */
  readonly files?: readonly ProjectChangeFile[];
}

export type ProjectChangeStatus = "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted" | "type_changed";
export type ProjectChangeGroup = "staged" | "changes" | "conflicts";

/** Provider-neutral file change, scoped to the selected repository/project folder. */
export interface ProjectChangeFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: ProjectChangeStatus;
  readonly group: ProjectChangeGroup;
  readonly diff: string;
  readonly notice?: string;
}

/**
 * Where a session's runs execute.
 *
 * - `shared`: the project folder itself. Several shared sessions may run at
 *   the same time and edit the same files; nothing isolates them (the same
 *   behavior as T3 Code's "Current checkout" and Codex's Local mode).
 * - `isolated`: a Git worktree owned by that one session, on its own branch,
 *   created on the session's first run.
 */
export type WorkspaceMode = "shared" | "isolated";

/**
 * A session-owned Git worktree. Persisted on the project so it survives
 * restarts; the directory itself may be removed and is recreated from
 * `branch` on the session's next run.
 */
export interface IsolatedWorkspace {
  readonly sessionId: string;
  /** Root of the linked worktree. */
  readonly worktreePath: string;
  /**
   * Execution directory: the worktree root plus the project folder's path
   * inside its repository, so a project that is a repository subfolder keeps
   * the same relative scope.
   */
  readonly path: string;
  /** Session branch, for example `rack/1a2b3c4d`. */
  readonly branch: string;
  /** Branch (or `HEAD` when detached) the worktree was created from. */
  readonly baseRef: string;
  /** Commit the branch started at. */
  readonly baseCommit: string;
  /** Root of the main checkout the worktree belongs to. */
  readonly checkoutRoot: string;
  readonly createdAt: string;
}

/** One run currently writing in a project, tracked in memory by the host. */
export interface ProjectWriter {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly mode: WorkspaceMode;
}

/** Live state of a session's workspace, for presentation. */
export interface SessionWorkspaceState {
  readonly mode: WorkspaceMode;
  /** Directory runs use (or will use, for an isolated workspace not yet created). */
  readonly path?: string;
  readonly workspace?: IsolatedWorkspace;
  /** False when an isolated worktree was removed or not created yet. */
  readonly exists: boolean;
  /** Uncommitted changes in an existing isolated worktree. */
  readonly dirty?: boolean;
  /** Commits on the session branch since `baseCommit`. */
  readonly commitsAhead?: number;
}

/** The selected folder, its sessions, and the isolated worktrees they own. */
export interface ProjectRecord {
  readonly id: ProjectId;
  readonly path: string;
  readonly startingRevision?: string;
  /**
   * Legacy persisted writer lock. Writer ownership is now tracked in memory
   * by the execution host (see `ProjectsService.activeWriters`), because a
   * persisted lock cannot outlive the process that held it and only
   * survived crashes as a stale lock. Older documents may still carry this
   * field; it is ignored.
   */
  readonly activeWriterAttemptId?: string;
  /** Session-owned worktrees; absent means none were created. */
  readonly isolatedWorkspaces?: readonly IsolatedWorkspace[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateProjectInput {
  readonly id?: ProjectId;
  readonly path: string;
  readonly startingRevision?: string;
}
