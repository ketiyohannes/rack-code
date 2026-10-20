/**
 * Stable error codes returned by host commands.
 *
 * The UI specification requires clients to branch on a stable code rather
 * than parse English messages. `details` carries structured context for the
 * few errors whose recovery needs it, such as the attempt that owns a busy
 * project.
 */
export type HostErrorCode =
  | "invalid_input"
  | "unknown_command"
  | "duplicate_account"
  | "provider_mismatch"
  | "account_not_found"
  | "no_eligible_account"
  | "project_not_found"
  | "branch_operation_failed"
  /** The session already has an active run; each session runs one turn at a time. */
  | "session_busy"
  /** Isolated sessions need Git and a repository with at least one commit. */
  | "isolation_unavailable"
  /** A worktree with uncommitted changes needs an explicit force to remove. */
  | "workspace_dirty"
  | "session_not_found"
  | "session_busy"
  | "file_conflict"
  | "runtime_not_found"
  | "run_not_found"
  | "run_not_active"
  | "attempt_not_found"
  | "approval_not_found"
  | "connector_not_found"
  | "connect_not_found"
  | "host_unavailable"
  /** An optional feature was not assembled in this host. */
  | "feature_unavailable"
  /** Timeline settings cannot change while a run edits the project. */
  | "timeline_busy"
  /** The session's project cannot host Timeline snapshots. */
  | "timeline_unsupported"
  /** "No snapshot for this action". */
  | "snapshot_not_found"
  /** "File is not part of this snapshot". */
  | "snapshot_path_invalid"
  | "internal";

export interface HostErrorPayload {
  readonly code: HostErrorCode;
  /** Original error class name, kept for diagnostics. */
  readonly name: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, string>>;
}

/**
 * Error thrown on the client side of the bridge when a command fails. It
 * reconstructs the payload so callers can switch on `code`.
 */
export class HostCommandError extends Error {
  readonly code: HostErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(payload: HostErrorPayload) {
    super(payload.message);
    this.name = payload.name;
    this.code = payload.code;
    this.details = payload.details ?? {};
  }
}
