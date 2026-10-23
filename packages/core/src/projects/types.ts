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
  /** Upstream tracking branch (for example `origin/main`); absent when the branch is unpublished or detached. */
  readonly upstream?: string;
  /** Commits on HEAD not on the upstream; present only with `upstream`. */
  readonly ahead?: number;
  /** Commits on the upstream not on HEAD; present only with `upstream`. */
  readonly behind?: number;
  /** True while a merge is in progress (`MERGE_HEAD` exists): the next commit concludes it. */
  readonly merging?: boolean;
  /** False before the repository's first commit; unstaging then empties the index instead of restoring HEAD. */
  readonly hasCommits?: boolean;
}

/**
 * Explicit Git operations from the Changes panel, modelled on VS Code's
 * Source Control view. Paths are relative to the selected repository folder,
 * exactly as `ProjectChangeFile.path`/`previousPath` report them; the adapter
 * rejects absolute paths and parent-directory segments. "All" variants are
 * separate kinds so that a missing `paths` field can never widen a discard.
 *
 * - `stage`/`stageAll`: add working-tree changes (including deletions and
 *   untracked files) to the index; staging a conflicted file marks it resolved.
 * - `unstage`/`unstageAll`: restore index entries from HEAD (or remove them
 *   before the first commit). Working files are untouched.
 * - `discard`/`discardAll`: restore tracked files from the index and delete
 *   untracked files. Irreversible; the renderer confirms first.
 * - `commit`: commit the index. `all` stages every change in the folder first
 *   (VS Code's "smart commit"); `amend` rewrites the last commit; an empty
 *   message is allowed only to amend or to conclude a merge with Git's
 *   prepared message.
 * - `fetch`/`pull`/`push`/`sync`: network operations. Push publishes an
 *   unpublished branch to the only/`origin` remote with upstream tracking;
 *   sync pulls (when an upstream exists) and then pushes.
 * - `merge`: merge a listed local or remote-tracking ref into HEAD; conflicts
 *   are a successful result that leaves the merge in progress.
 * - `abortMerge`: `git merge --abort`.
 * - `createBranch`: create a branch at HEAD and switch to it, keeping changes.
 */
export type SourceControlAction =
  | { readonly kind: "stage"; readonly paths: readonly string[] }
  | { readonly kind: "stageAll" }
  | { readonly kind: "unstage"; readonly paths: readonly string[] }
  | { readonly kind: "unstageAll" }
  | { readonly kind: "discard"; readonly paths: readonly string[] }
  | { readonly kind: "discardAll" }
  | { readonly kind: "commit"; readonly message: string; readonly amend?: boolean; readonly all?: boolean }
  | { readonly kind: "fetch" }
  | { readonly kind: "pull" }
  | { readonly kind: "push" }
  | { readonly kind: "sync" }
  | { readonly kind: "merge"; readonly ref: string }
  | { readonly kind: "abortMerge" }
  | { readonly kind: "createBranch"; readonly name: string };

export type SourceControlActionKind = SourceControlAction["kind"];

/** Outcome of a completed operation; `summary` is a short user-facing sentence. */
export interface SourceControlResult {
  readonly summary: string;
  /** True when a merge or pull stopped with conflicts that the user must resolve. */
  readonly conflicts?: boolean;
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

/** A checkout candidate. Full ref names are opaque identities, never shell input. */
export interface ProjectBranch {
  readonly ref: string;
  readonly name: string;
  readonly kind: "local" | "remote";
  readonly commit: string;
  readonly worktreePath?: string;
}
/** Branch controls explicitly target the project checkout, not a session worktree. */
export interface ProjectBranches {
  readonly repositoryRoot: string;
  readonly repositoryId: string;
  readonly current?: string;
  readonly head?: string;
  readonly dirty: boolean;
  readonly branches: readonly ProjectBranch[];
}
