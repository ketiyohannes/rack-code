export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectError";
  }
}

export class ProjectNotFoundError extends ProjectError {
  constructor(projectId: string) {
    super(`Project '${projectId}' was not found.`);
    this.name = "ProjectNotFoundError";
  }
}

export class InvalidProjectError extends ProjectError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProjectError";
  }
}

/** A session already has an active run; each session runs one turn at a time. */
export class SessionBusyError extends ProjectError {
  constructor(readonly sessionId: string, readonly attemptId: string) {
    super(`Session '${sessionId}' already has an active run (attempt '${attemptId}').`);
    this.name = "SessionBusyError";
  }
}

/** Isolated sessions need a Git repository with at least one commit. */
export class IsolationUnavailableError extends ProjectError {
  constructor(message: string) {
    super(message);
    this.name = "IsolationUnavailableError";
  }
}

/** Removing a worktree with uncommitted changes requires an explicit force. */
export class WorkspaceDirtyError extends ProjectError {
  constructor(readonly path: string) {
    super("This worktree has uncommitted changes. Commit them, or remove the worktree anyway to discard them.");
    this.name = "WorkspaceDirtyError";
  }
}

/** User-facing refusal of an explicit branch operation; no force fallback is allowed. */
export class BranchOperationError extends ProjectError {
  constructor(message: string) { super(message); this.name = "BranchOperationError"; }
}

/**
 * A Git operation requested from the Changes panel failed or was refused.
 * The message is user-facing: it carries Git's own explanation (with
 * credentials redacted) or Rack's reason for refusing.
 */
export class GitOperationError extends ProjectError {
  constructor(message: string) { super(message); this.name = "GitOperationError"; }
}
