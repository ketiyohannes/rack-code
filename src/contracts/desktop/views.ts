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
import type { AccountAvailability, AccountIdentity } from "../../core/accounts/types.js";
import type { UserQuestionRequest } from "../../core/execution/question-types.js";
export type { UserQuestion, UserQuestionRequest, UserQuestionResponse } from "../../core/execution/question-types.js";
import type {
  ApprovalRequest,
  AttemptRecord,
  JournalEntry,
  PermissionMode,
  RunRecord,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeModel,
} from "../../core/execution/types.js";
import type { ProjectRecord } from "../../core/projects/types.js";
export type { ProjectChanges, ProjectChangeFile, ProjectChangeGroup, ProjectChangeStatus, ProjectRepositories, RepositoryDiscoveryOptions } from "../../core/projects/types.js";
import type { ConnectView } from "../../core/connections/types.js";
import type { SessionMessage, SessionRecord } from "../../core/sessions/types.js";
export type { SessionDiscovery, ExternalSessionSnapshot, ImportSessionResult, DiscoveredSession } from "../../core/session-imports/types.js";
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
} from "../../features/timeline/types.js";

export type {
  AccountAvailability,
  ConnectView,
  ApprovalRequest,
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

export type ProjectView = ProjectRecord;

/** Navigator row for a session; messages are loaded separately. */
export interface SessionSummaryView {
  readonly id: string;
  /** Absent for a standalone chat. */
  readonly projectId?: string;
  readonly title?: string;
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

/** A provider that offers "Connect <displayName> account". */
export interface ConnectProviderView {
  readonly providerId: string;
  readonly displayName: string;
}

export type { ProviderDiagnostic } from "../../core/connections/ports.js";
