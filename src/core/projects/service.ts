import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  BranchOperationError,
  GitOperationError,
  InvalidProjectError,
  IsolationUnavailableError,
  ProjectNotFoundError,
  SessionBusyError,
} from "./errors.js";
import type { IsolatedWorkspaceProvider, ProjectChangesReader, ProjectSourceControl, ProjectStore } from "./ports.js";
import type {
  CreateProjectInput,
  IsolatedWorkspace,
  ProjectId,
  ProjectRecord,
  ProjectWriter,
  SessionWorkspaceState,
  SourceControlAction,
  SourceControlActionKind,
  SourceControlResult,
  WorkspaceMode,
} from "./types.js";

/**
 * Operations that rewrite tracked working files wholesale. They are refused
 * while a run writes in the same working tree, so an agent never has its
 * files replaced mid-edit. Stage/commit/push only touch the index and refs,
 * and discard is a targeted, confirmed user choice (as in VS Code).
 */
const TREE_REWRITING: ReadonlySet<SourceControlActionKind> = new Set(["pull", "sync", "merge", "abortMerge"]);

export interface ProjectsServiceOptions {
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly changes?: ProjectChangesReader;
  readonly branches?: import("./ports.js").ProjectBranchRepository;
  /** Explicit Changes-panel Git operations; without it they are unavailable. */
  readonly sourceControl?: ProjectSourceControl;
  /** Session worktree support; without it, isolated sessions are unavailable. */
  readonly isolation?: { readonly provider: IsolatedWorkspaceProvider; readonly worktreesRoot: string };
}

/**
 * Owns top-level project identity, execution directories, and writer
 * ownership.
 *
 * A project is the product's unit of folder context. Sessions, model
 * discovery, execution paths, and concurrency all reference this record
 * directly. "Workspace" is another name for this same project, not a second
 * record or identity. Isolated execution directories (session worktrees)
 * belong to the project record rather than forming another hierarchy.
 *
 * Concurrency model (decided 2026-10-15, following T3 Code and Codex):
 * - each session runs one turn at a time (`SessionBusyError`);
 * - shared sessions run in the project folder and may run concurrently with
 *   each other; their edits are not isolated;
 * - an isolated session runs in its own worktree, so it never shares files
 *   with other sessions.
 *
 * Writer ownership lives in memory. The execution host owns every run, and
 * no run survives the host, so a persisted lock could only ever be stale.
 */
export class ProjectsService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly changes: ProjectChangesReader | undefined;
  private readonly branches: ProjectsServiceOptions["branches"];
  private readonly sourceControlPort: ProjectSourceControl | undefined;
  private readonly isolation: ProjectsServiceOptions["isolation"];
  /** Serializes project record updates within this execution host. */
  private mutation: Promise<void> = Promise.resolve();
  /**
   * While set, a checkout or tree-rewriting Git operation is between its
   * active-run check and its completion; new runs are refused with this
   * message. It closes the race between the busy check and a run starting.
   */
  private treeBarrier: string | undefined;
  /** Active writers per project ID. */
  private readonly writers = new Map<ProjectId, ProjectWriter[]>();
  /** Serializes worktree preparation per session so two calls cannot both create one. */
  private readonly preparing = new Map<string, Promise<IsolatedWorkspace>>();

  constructor(
    private readonly store: ProjectStore,
    options: ProjectsServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.changes = options.changes;
    this.isolation = options.isolation;
    this.branches = options.branches;
    this.sourceControlPort = options.sourceControl;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    if (input.path.trim() === "") {
      throw new InvalidProjectError("Project path is required.");
    }
    return this.mutate(async () => {
      // Native pickers return absolute paths. Normalize separators, dot segments
      // and trailing slashes so adding that folder again reuses its identity.
      const path = resolve(input.path);
      const existing = (await this.store.listProjects()).find((project) => resolve(project.path) === path);
      if (existing !== undefined) return existing;
      const timestamp = this.now().toISOString();
      const project: ProjectRecord = {
        id: input.id ?? this.createId(),
        path,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(input.startingRevision === undefined ? {} : { startingRevision: input.startingRevision }),
      };
      await this.store.saveProject(project);
      return project;
    });
  }

  /** Lists projects in creation order for the navigator. */
  async listProjects(): Promise<readonly ProjectRecord[]> {
    const projects = await this.store.listProjects();
    return [...projects].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getProject(projectId: ProjectId): Promise<ProjectRecord> {
    const project = await this.store.getProject(projectId);
    if (project === undefined) throw new ProjectNotFoundError(projectId);
    return project;
  }

  /**
   * Reads changes in the project folder, or in an isolated session's worktree
   * when `sessionId` names one that exists. Paths always come from saved
   * records; clients cannot request arbitrary folders.
   */
  async getChanges(projectId: ProjectId, repositoryPath?: string, sessionId?: string): Promise<import("./types.js").ProjectChanges> {
    const root = await this.viewRoot(projectId, sessionId);
    if (!this.changes) return { status: "unavailable", diff: "", truncated: false };
    return repositoryPath === undefined ? this.changes.read(root) : this.changes.readRepository(root, repositoryPath);
  }

  /** Discover repositories for the view without changing execution's project path. */
  async discoverRepositories(projectId: ProjectId, options: import("./types.js").RepositoryDiscoveryOptions = {}, sessionId?: string): Promise<import("./types.js").ProjectRepositories> {
    const root = await this.viewRoot(projectId, sessionId);
    if (!this.changes) return { paths: [], limited: false, warnings: ["Repository discovery is unavailable."] };
    return this.changes.discover(root, options);
  }

  /** Called once before a new host accepts work. Old process-owned locks cannot be live here. */
  async recoverAbandonedWriters(): Promise<void> {
    await this.mutate(async () => {
      for (const project of await this.store.listProjects()) {
        if (project.activeWriterAttemptId === undefined) continue;
        const { activeWriterAttemptId: _oldOwner, ...rest } = project;
        await this.store.saveProject({ ...rest, updatedAt: this.now().toISOString() });
      }
    });
  }

  /**
   * Registers a run as writing in the project. Rejects with
   * `SessionBusyError` when the same session already has an active run.
   * Shared sessions may write concurrently; isolated sessions write only in
   * their own worktree. Idempotent for the same attempt.
   */
  async acquireWriter(projectId: ProjectId, attemptId: string, owner: { readonly sessionId: string; readonly mode: WorkspaceMode }): Promise<void> {
    await this.getProject(projectId);
    const writers = this.writers.get(projectId) ?? [];
    if (writers.some((writer) => writer.attemptId === attemptId)) return;
    if (this.treeBarrier !== undefined) throw new BranchOperationError(this.treeBarrier);
    const busy = writers.find((writer) => writer.sessionId === owner.sessionId);
    if (busy !== undefined) throw new SessionBusyError(owner.sessionId, busy.attemptId);
    this.writers.set(projectId, [...writers, { attemptId, sessionId: owner.sessionId, mode: owner.mode }]);
  }

  /** Removes a run's writer registration; unknown attempts are ignored. */
  async releaseWriter(projectId: ProjectId, attemptId: string): Promise<void> {
    const remaining = (this.writers.get(projectId) ?? []).filter((writer) => writer.attemptId !== attemptId);
    if (remaining.length === 0) this.writers.delete(projectId);
    else this.writers.set(projectId, remaining);
  }

  /**
   * Reads checkout candidates, including remote-tracking refs, for the
   * project's own checkout or a discovered repository inside it
   * (`repositoryPath`), or for an isolated session's worktree (`sessionId`,
   * listing only: session worktrees keep their recorded branch).
   */
  async listBranches(projectId: ProjectId, repositoryPath?: string, sessionId?: string): Promise<import("./types.js").ProjectBranches> {
    if (!this.branches) throw new BranchOperationError("Branch checkout is unavailable in this host.");
    return this.branches.list(await this.viewRoot(projectId, sessionId), repositoryPath);
  }

  /**
   * Checkout is explicit, never forced, and cannot race an app-managed run.
   * Compare repository identities for aliases and isolated worktrees too: a
   * project folder and its subfolder may be saved as different project IDs.
   * The barrier is set before any await; acquireWriter rechecks after its await.
   */
  async checkoutBranch(projectId: ProjectId, ref: string, expectedHead: string, repositoryPath?: string): Promise<import("./types.js").ProjectBranches> {
    if (!this.branches) throw new BranchOperationError("Branch checkout is unavailable in this host.");
    if (this.treeBarrier !== undefined) throw new BranchOperationError("Another branch checkout or Git update is in progress.");
    this.treeBarrier = "A branch checkout is in progress. Try starting the run again after it finishes.";
    try {
      const project = await this.getProject(projectId);
      // A discovered repository inside a container folder has its own identity.
      const repositoryId = repositoryPath === undefined ? await this.branches.repositoryId(project.path)
        : (await this.branches.list(project.path, repositoryPath)).repositoryId;
      for (const [id, writers] of this.writers) {
        if (!writers.length) continue;
        const other = await this.getProject(id);
        if (id === projectId || await this.branches.repositoryId(other.path).catch(() => undefined) === repositoryId)
          throw new BranchOperationError("Stop active runs in this repository before checking out a branch.");
      }
      return await this.branches.checkout(project.path, ref, expectedHead, repositoryPath);
    } finally { this.treeBarrier = undefined; }
  }

  /**
   * Performs a Changes-panel Git operation in the project folder, a
   * discovered repository inside it, or an isolated session's worktree.
   *
   * Isolated worktrees cannot create or switch branches here: their record
   * names the branch the worktree is restored from, and switching would make
   * the next restore check out different work. Pull, sync, merge and abort
   * merge are refused while any run writes in the same working tree
   * (compared by canonical root, so aliases of one checkout match and
   * separate worktrees of one repository do not).
   */
  async sourceControl(projectId: ProjectId, repositoryPath: string | undefined, sessionId: string | undefined, action: SourceControlAction): Promise<SourceControlResult> {
    const port = this.sourceControlPort;
    if (port === undefined) throw new GitOperationError("Git operations are unavailable in this host.");
    const root = await this.viewRoot(projectId, sessionId);
    if (sessionId !== undefined && action.kind === "createBranch")
      throw new GitOperationError("An isolated session keeps its own branch. Create branches from the project checkout.");
    if (!TREE_REWRITING.has(action.kind)) return port.run(root, repositoryPath, action);
    if (this.treeBarrier !== undefined) throw new GitOperationError("Another branch checkout or Git update is in progress.");
    this.treeBarrier = "Git is updating files in a checkout. Try starting the run again after it finishes.";
    try {
      const target = await port.workTreeRoot(root, repositoryPath);
      for (const [id, writers] of this.writers) {
        for (const writer of writers) {
          const directory = await this.writerDirectory(id, writer).catch(() => undefined);
          const other = directory === undefined ? undefined : await port.workTreeRoot(directory).catch(() => undefined);
          if (other === target) throw new GitOperationError("Stop active runs in this checkout before pulling or merging. Their files would change underneath them.");
        }
      }
      return await port.run(root, repositoryPath, action);
    } finally { this.treeBarrier = undefined; }
  }

  /** Runs currently writing in the project, in start order. */
  activeWriters(projectId: ProjectId): readonly ProjectWriter[] {
    return [...(this.writers.get(projectId) ?? [])];
  }

  /** `undefined` when isolated sessions are possible for the project, otherwise a reason. */
  async isolationUnavailableReason(projectId: ProjectId): Promise<string | undefined> {
    const project = await this.getProject(projectId);
    if (this.isolation === undefined) return "Isolated sessions are not available in this application.";
    return this.isolation.provider.unsupportedReason(project.path);
  }

  /**
   * Directory a session's run executes in. Shared sessions use the project
   * folder. Isolated sessions use their worktree, which is created on first
   * use and recreated from its branch when it was removed. Creation is
   * serialized per session; the provider serializes per repository.
   */
  async prepareExecutionDirectory(projectId: ProjectId, sessionId: string, mode: WorkspaceMode): Promise<{ readonly path: string; readonly workspace?: IsolatedWorkspace }> {
    const project = await this.getProject(projectId);
    if (mode === "shared") return { path: project.path };
    const pending = this.preparing.get(sessionId);
    const operation = (pending ?? Promise.resolve()).catch(() => undefined).then(() => this.ensureWorkspace(project.id, sessionId));
    this.preparing.set(sessionId, operation);
    try {
      const workspace = await operation;
      return { path: workspace.path, workspace };
    } finally {
      if (this.preparing.get(sessionId) === operation) this.preparing.delete(sessionId);
    }
  }

  /** The recorded worktree of an isolated session, if one was ever created. */
  async isolatedWorkspace(projectId: ProjectId, sessionId: string): Promise<IsolatedWorkspace | undefined> {
    return (await this.getProject(projectId)).isolatedWorkspaces?.find((workspace) => workspace.sessionId === sessionId);
  }

  /** Workspace details for presentation; never creates or restores anything. */
  async workspaceState(projectId: ProjectId, sessionId: string, mode: WorkspaceMode): Promise<SessionWorkspaceState> {
    const project = await this.getProject(projectId);
    if (mode === "shared") return { mode, path: project.path, exists: true };
    const workspace = project.isolatedWorkspaces?.find((candidate) => candidate.sessionId === sessionId);
    if (workspace === undefined || this.isolation === undefined) return { mode, exists: false };
    const exists = await this.isolation.provider.exists(workspace);
    if (!exists) return { mode, path: workspace.path, workspace, exists };
    const status = await this.isolation.provider.status(workspace).catch(() => undefined);
    return { mode, path: workspace.path, workspace, exists, ...(status === undefined ? {} : status) };
  }

  /**
   * Removes an isolated session's worktree directory and keeps its branch
   * and record, as T3 Code does; the next run recreates the worktree from
   * the branch. Refused while the session has an active run, and for
   * uncommitted changes unless `force` is set.
   */
  async removeIsolatedWorkspace(projectId: ProjectId, sessionId: string, force: boolean): Promise<void> {
    const busy = this.activeWriters(projectId).find((writer) => writer.sessionId === sessionId);
    if (busy !== undefined) throw new SessionBusyError(sessionId, busy.attemptId);
    const workspace = await this.isolatedWorkspace(projectId, sessionId);
    if (workspace === undefined || this.isolation === undefined) return;
    if (!(await this.isolation.provider.exists(workspace))) return;
    await this.isolation.provider.remove(workspace, { force });
  }

  private async ensureWorkspace(projectId: ProjectId, sessionId: string): Promise<IsolatedWorkspace> {
    if (this.isolation === undefined) throw new IsolationUnavailableError("Isolated sessions are not available in this application.");
    const { provider, worktreesRoot } = this.isolation;
    const project = await this.getProject(projectId);
    const existing = project.isolatedWorkspaces?.find((workspace) => workspace.sessionId === sessionId);
    if (existing !== undefined) {
      if (!(await provider.exists(existing))) await provider.restore(existing);
      return existing;
    }
    const reason = await provider.unsupportedReason(project.path);
    if (reason !== undefined) throw new IsolationUnavailableError(reason);
    const created: IsolatedWorkspace = {
      ...(await provider.create({ projectPath: project.path, worktreesRoot, sessionId })),
      createdAt: this.now().toISOString(),
    };
    await this.mutate(async () => {
      const current = await this.getProject(projectId);
      await this.store.saveProject({
        ...current,
        isolatedWorkspaces: [...(current.isolatedWorkspaces ?? []).filter((workspace) => workspace.sessionId !== sessionId), created],
        updatedAt: this.now().toISOString(),
      });
    });
    return created;
  }

  /** Reads an execution path without creating a worktree. Missing isolated
   * worktrees must never redirect tools into the shared checkout. */
  async executionPath(projectId: ProjectId, sessionId: string, mode: WorkspaceMode): Promise<string> {
    return this.viewRoot(projectId, mode === "isolated" ? sessionId : undefined);
  }

  /** Where a registered writer's run edits files: the project folder or its session worktree. */
  private async writerDirectory(projectId: ProjectId, writer: ProjectWriter): Promise<string> {
    const project = await this.getProject(projectId);
    if (writer.mode === "shared") return project.path;
    const workspace = project.isolatedWorkspaces?.find((candidate) => candidate.sessionId === writer.sessionId);
    if (workspace === undefined) throw new IsolationUnavailableError("The session's worktree is not created yet.");
    return workspace.path;
  }

  /** Project folder, or an existing isolated worktree of the named session. */
  private async viewRoot(projectId: ProjectId, sessionId: string | undefined): Promise<string> {
    const project = await this.getProject(projectId);
    if (sessionId === undefined) return project.path;
    const workspace = project.isolatedWorkspaces?.find((candidate) => candidate.sessionId === sessionId);
    if (workspace === undefined || !this.isolation || !(await this.isolation.provider.exists(workspace))) {
      throw new IsolationUnavailableError("Send a message to create or restore this session's isolated worktree.");
    }
    return workspace.path;
  }

  /** A rejected mutation must not block later commands. */
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(operation);
    this.mutation = next.then(() => undefined, () => undefined);
    return next;
  }
}
