/**
 * Serializable read models sent from the execution host to desktop clients.
 *
 * Views reuse application-owned domain types where those types are already
 * safe to display, so this file does not become a second domain model. The
 * exception is accounts: `AccountView` omits the credential reference and
 * runtime-context ID, which the UI specification forbids displaying.
 *
 * Only type-only imports from core `types.ts` files are allowed here. The
 * renderer compiles this module for a browser target and must not pull in
 * Node.js services.
 */
import type { AccountAvailability, AccountIdentity } from "@rack/core/accounts/types";
import type { UserQuestionRequest } from "@rack/core/execution/question-types";
export type { UserQuestion, UserQuestionRequest, UserQuestionResponse } from "@rack/core/execution/question-types";
import type {
  ApprovalRequest,
  AttemptRecord,
  JournalEntry,
  McpToolIdentity,
  PermissionMode,
  RunRecord,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeModel,
} from "@rack/core/execution/types";
import type { ProjectRecord, ProjectWriter } from "@rack/core/projects/types";
export type { IsolatedWorkspace, ProjectWriter, SessionWorkspaceState as SessionWorkspaceView, WorkspaceMode } from "@rack/core/projects/types";
export type { ProjectBranches, ProjectBranch, ProjectChanges, ProjectChangeFile, ProjectChangeGroup, ProjectChangeStatus, ProjectRepositories, RepositoryDiscoveryOptions, SourceControlAction, SourceControlActionKind, SourceControlResult } from "@rack/core/projects/types";
import type { ConnectView } from "@rack/core/connections/types";
import type { QueuedMessage, QueuePauseReason, SessionMessage, SessionQueue, SessionRecord } from "@rack/core/sessions/types";
export type { SessionDiscovery, ExternalSessionSnapshot, ImportSessionResult, DiscoveredSession } from "@rack/core/session-imports/types";
// Optional Timeline feature read models; type-only, safe for the renderer bundle.
export type {
  TimelineChangedPath,
  TimelineChangeStatus,
  TimelineCheckpointEntry,
  TimelineCheckpointList,
  TimelineProjectHistory,
  TimelineProjectHistoryEntry,
  TimelineFileDiff,
  TimelineStatus,
  TimelineSnapshotTarget,
  TimelineSnapshotChoice,
  TimelineSnapshotHistory,
  TimelineSnapshot,
  TimelineSnapshotFile,
  TimelineSnapshotFileView,
  TimelineFileContent,
} from "@rack/features/timeline/types";

export type {
  AccountAvailability,
  ConnectView,
  ApprovalRequest,
  McpToolIdentity,
  PermissionMode,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeModel,
};

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "read_only",
  "ask",
  "approve_for_me",
  "full_access",
];

/** Account fields safe to display. Credential material and context paths are absent. */
export interface AccountView {
  readonly id: string;
  readonly providerId: string;
  readonly identity: AccountIdentity;
  readonly availability: AccountAvailability;
  readonly availabilityReason?: string;
  readonly quotaResetAt?: string;
  readonly lastUsedAt?: string;
  readonly createdAt: string;
  /** True when this account is the provider's selected account. */
  readonly selected: boolean;
  /** Number of active attempts currently using this account. */
  readonly activeAttempts: number;
}

/**
 * A project with the runs currently writing in it. The legacy persisted
 * writer field is omitted; `activeWriters` is the live, in-memory state.
 */
export type ProjectView = Omit<ProjectRecord, "activeWriterAttemptId"> & {
  readonly activeWriters: readonly ProjectWriter[];
};

/** Navigator row for a session; messages are loaded separately. */
export interface SessionSummaryView {
  readonly id: string;
  /** Absent for a standalone chat. */
  readonly projectId?: string;
  readonly title?: string;
  /** Absent means `shared`. */
  readonly workspaceMode?: "shared" | "isolated";
  readonly messageCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Full session for the conversation view. Native continuation IDs are
 * diagnostic metadata and are kept separate from the session identity.
 */
export type SessionView = SessionRecord;
export type SessionMessageView = SessionMessage;
/**
 * A session's waiting messages (`SessionView.queue`). The host owns it;
 * clients render it and change it only through the `queue.*` commands.
 */
export type SessionQueueView = SessionQueue;
export type QueuedMessageView = QueuedMessage;
export type QueuePauseReasonView = QueuePauseReason;

/** A run plus its attempts, enough to label it with runtime and account. */
export interface RunView extends RunRecord {
  readonly attempts: readonly AttemptRecord[];
}

export type AttemptView = AttemptRecord;
export type JournalEntryView = JournalEntry;

/** Runtime metadata retained for permission disclosures and host diagnostics. */
export interface RuntimeView {
  readonly runtimeId: string;
  readonly providerId?: string;
  /** Adapter-reported native controls for each app permission mode. */
  readonly permissionMappings: Readonly<Record<PermissionMode, string>>;
}

/** Model picker entry. Runtime/provider routing is deliberately hidden from the UI. */
export interface ModelView extends RuntimeModel {
  readonly runtimeId: string;
  readonly providerName: string;
  /** Accounts whose native catalogs included this model; never contains credentials. */
  readonly accountIds: readonly string[];
}

/** Partial discovery failures must not hide another connected provider's models. */
export interface ModelCatalogView {
  readonly models: readonly ModelView[];
  readonly failures: readonly { readonly providerName: string; readonly accountId: string }[];
}

/**
 * Snapshot of a run the host is currently executing.
 *
 * `events` holds every normalized runtime event the host has observed for the
 * run, in order. A client that connects late renders this snapshot and then
 * applies live `run.event` messages whose `index` is at least
 * `events.length`, which avoids both gaps and duplicates without replaying
 * the provider.
 */
export interface ActiveRunView {
  readonly run: RunView;
  readonly events: readonly RuntimeEvent[];
  /**
   * Host observation time (ISO 8601) of each entry in `events`, by index.
   * Optional so older hosts remain compatible.
   */
  readonly observedAt?: readonly string[];
  readonly pendingApprovals: readonly ApprovalRequest[];
  readonly pendingQuestions?: readonly UserQuestionRequest[];
  readonly cancelRequested: boolean;
  /** Provider's selected account at start time, when it differed from the account used. */
  readonly fallbackFromAccountId?: string;
}

/** Result of `runs.start`, including any account fallback the host applied. */
export interface StartRunResult {
  readonly run: RunView;
  readonly fallbackFromAccountId?: string;
}

/**
 * Result of a queue command that may start a run right away (`queue.add`
 * when the session was idle, `queue.sendNow` and `queue.resume`). `started`
 * is present only when a run started during the command; clients add it as
 * a live run exactly like a `runs.start` result. When the session was busy,
 * the run starts later and is announced by `run.started`.
 */
export interface QueueStartResult {
  readonly started?: StartRunResult;
}

/** A provider that offers "Connect <displayName> account". */
export interface ConnectProviderView {
  readonly supportsExistingLogin?: boolean;
  readonly providerId: string;
  readonly displayName: string;
}

export type { ProviderDiagnostic } from "@rack/core/connections/ports";
