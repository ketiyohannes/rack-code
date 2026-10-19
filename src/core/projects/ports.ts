import type { IsolatedWorkspace, ProjectChanges, ProjectId, ProjectRecord, ProjectRepositories, RepositoryDiscoveryOptions } from "./types.js";

/** Platform adapters supply current changes without mutating the project. */
export interface ProjectChangesReader {
  read(path: string): Promise<ProjectChanges>;
  discover(path: string, options: RepositoryDiscoveryOptions): Promise<ProjectRepositories>;
  readRepository(path: string, repositoryPath: string): Promise<ProjectChanges>;
}

export interface ProjectStore {
  listProjects(): Promise<readonly ProjectRecord[]>;
  getProject(projectId: ProjectId): Promise<ProjectRecord | undefined>;
  saveProject(project: ProjectRecord): Promise<void>;
}

/** Input for creating a session worktree. */
export interface IsolatedWorkspaceRequest {
  /** Project folder; the worktree is created from its repository's HEAD. */
  readonly projectPath: string;
  /** Directory under which managed worktrees are created. */
  readonly worktreesRoot: string;
  readonly sessionId: string;
}

/**
 * Creates and manages session-owned Git worktrees.
 *
 * Neither runtime exposes worktree management to an embedding application
 * (the Codex app server and the Claude Agent SDK accept a working directory;
 * their worktree features live in their own CLIs and desktop apps), so Rack
 * owns this and hands runtimes the resulting directory.
 *
 * Implementations never modify the main checkout's working files, index, or
 * HEAD. They create branches and linked worktrees only.
 */
export interface IsolatedWorkspaceProvider {
  /** `undefined` when supported, otherwise a user-facing reason. */
  unsupportedReason(projectPath: string): Promise<string | undefined>;
  create(request: IsolatedWorkspaceRequest): Promise<Omit<IsolatedWorkspace, "createdAt">>;
  /** True when the worktree directory exists and is still a linked worktree. */
  exists(workspace: IsolatedWorkspace): Promise<boolean>;
  /** Recreates a removed worktree from its branch (or base commit when the branch is gone). */
  restore(workspace: IsolatedWorkspace): Promise<void>;
  /** Uncommitted changes and commits since the base, for an existing worktree. */
  status(workspace: IsolatedWorkspace): Promise<{ readonly dirty: boolean; readonly commitsAhead: number }>;
  /**
   * Removes the worktree directory and keeps its branch. Rejects with
   * `WorkspaceDirtyError` when it has uncommitted changes and `force` is false.
   */
  remove(workspace: IsolatedWorkspace, options: { readonly force: boolean }): Promise<void>;
}
