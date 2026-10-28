import { validateWorkflow, type AgentModel, type OrchestraSnapshot, type WorkflowDefinition, type WorkflowRun } from "@rack/features/orchestration/types";
import type { AccountCatalog, AccountLogin, AccountLoginResult, InboxQuery, InboxResult, InboxTarget, RepositoryTarget, InboxDetail } from "@rack/features/pull-requests";
import type { ReviewRepository, PullDetail, PullList, PullRequest, CreatePull, PullState, ReviewAction } from "@rack/features/pull-requests";
import type { UsageReport } from "@rack/features/usage";
/**
 * Typed command surface exposed by the execution host to desktop clients.
 *
 * `HostCommandMap` is the single source of truth: each entry names the
 * parameters a client sends and the result it receives. `COMMAND_VALIDATORS`
 * holds the matching runtime validators. Adding a command means adding one
 * entry to each, then a handler in the host; the compiler flags any missing
 * piece because the host handler table is typed against this map.
 *
 * Commands are direct request/response calls. Facts that happen later, such
 * as streamed runtime output, arrive separately as `HostEvent`s.
 */
import {
  empty,
  array,
  boolean,
  object,
  oneOf,
  optional,
  text,
  type Validator,
  ContractValidationError,
} from "./validation.js";
import { parseQuestionResponse, type UserQuestionResponse } from "@rack/core/execution/question-types";
import { MAX_ATTACHMENTS, type SessionAttachment } from "@rack/core/sessions/attachments";
import type { FileListing, FileDocument } from "@rack/features/files";
import type { TerminalSnapshot } from "@rack/features/terminal/types";
import type { BrowserRequest, BrowserSnapshot } from "@rack/features/browser";
import { integer } from "./validation.js";
import type { ProjectBranches, ProjectChanges, ProjectRepositories, RepositoryDiscoveryOptions, SourceControlActionKind, SourceControlResult } from "./views.js";
import {
  PERMISSION_MODES,
  type AccountView,
  type ActiveRunView,
  type ConnectProviderView,
  type ProviderDiagnostic,
  type ConnectView,
  type JournalEntryView,
  type PermissionMode,
  type RunView,
  type RuntimeCapabilities,
  type RuntimeView,
  type ModelCatalogView,
  type SessionSummaryView,
  type SessionView,
  type StartRunResult,
  type QueueStartResult,
  type QueuedMessageView,
  type ProjectView,
  type SessionDiscovery,
  type ExternalSessionSnapshot,
  type ImportSessionResult,
  type TimelineCheckpointList,
  type TimelineProjectHistory,
  type TimelineFileDiff,
  type TimelineStatus,
  type TimelineSnapshotTarget,
  type TimelineSnapshot,
  type TimelineSnapshotHistory,
  type TimelineSnapshotFileView,
  type SessionWorkspaceView,
  type WorkspaceMode,
} from "./views.js";

/** Opaque credential reference; the host obtains it, never the secret. */
export interface CredentialReferenceParams {
  readonly id: string;
  readonly providerId: string;
  readonly method: string;
}

export interface RegisterAccountParams {
  readonly providerId: string;
  readonly providerAccountId: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly credential: CredentialReferenceParams;
  readonly runtimeContextId: string;
}

export interface StartRunParams {
  /** IDs of session-owned copies, resolved by the host rather than trusting client paths. */
  readonly attachmentIds?: readonly string[];
  readonly sessionId: string;
  readonly projectId?: string;
  readonly providerId: string;
  readonly runtimeId: string;
  /** Omit to let the Accounts service choose the selected or fallback account. */
  readonly accountId?: string;
  readonly prompt: string;
  readonly model?: string;
  /** A level from the selected model's `reasoningEfforts`; omit for the provider default. */
  readonly reasoningEffort?: string;
  /** An option from the selected model's `speeds`; omit for the provider default. */
  readonly speed?: string;
  readonly permissionMode: PermissionMode;
  readonly interactionMode?: "normal" | "plan";
  readonly skillIds?: readonly string[];
  readonly approvedPlanRunId?: string;
}

/**
 * Run settings stored with a queued message: everything `runs.start` takes
 * except what the queue supplies itself (session, project, prompt and
 * attachments). Plan approvals cannot be queued.
 */
export type QueuedRunSettingsParams = Omit<StartRunParams, "sessionId" | "projectId" | "prompt" | "attachmentIds" | "approvedPlanRunId">;

export interface QueueAddParams {
  readonly sessionId: string;
  readonly prompt: string;
  readonly attachmentIds?: readonly string[];
  readonly settings: QueuedRunSettingsParams;
}

type NoParams = Record<string, never>;

export interface HostCommandMap {
  "orchestra.snapshot": { params: NoParams; result: OrchestraSnapshot };
  "orchestra.save": { params: { definition: WorkflowDefinition }; result: WorkflowDefinition };
  "orchestra.remove": { params: { workflowId: string }; result: null };
  "orchestra.bind": { params: { sessionId: string; workflowId?: string }; result: null };
  "orchestra.start": { params: { input: StartRunParams; workflowId: string }; result: WorkflowRun };
  "orchestra.control": { params: { runId: string; action: "pause" | "resume" | "approve" | "stop" }; result: null };
  "orchestra.generate": { params: { sessionId: string; description: string; model: AgentModel; generationId: string }; result: WorkflowDefinition };
  "orchestra.cancelGeneration": { params: { generationId: string }; result: null };
  "reviews.accounts": { params: { refresh?: boolean }; result: AccountCatalog };
  /** Browser sign-in through gh: begin returns the device code, finish waits for authorization. */
  "reviews.accountLoginBegin": { params: { host: string }; result: AccountLogin };
  "reviews.accountLoginFinish": { params: { loginId: string }; result: AccountLoginResult };
  "reviews.accountLoginCancel": { params: { loginId: string }; result: null };
  "reviews.inbox": { params: InboxQuery; result: InboxResult };
  "reviews.inboxRepository": { params: RepositoryTarget & { query: string; state: PullState; page: number }; result: PullList };
  "reviews.inboxCreate": { params: RepositoryTarget & { input: CreatePull }; result: PullRequest };
  "reviews.inboxDetail": { params: InboxTarget; result: InboxDetail };
  "reviews.inboxAct": { params: InboxTarget & { action: ReviewAction; body: string; head: string }; result: null };
  "reviews.inboxSync": { params: InboxTarget & { projectId?: string }; result: { projectId: string; checkpointId: string } };
  "reviews.repositories": { params: { projectId: string }; result: readonly ReviewRepository[] };
  "reviews.connect": { params: { projectId: string; remote: string; token: string }; result: null };
  "reviews.list": { params: { projectId: string; remote: string; query: string; state: PullState; page: number }; result: PullList };
  "reviews.detail": { params: { projectId: string; remote: string; id: number }; result: PullDetail };
  "reviews.create": { params: { projectId: string; remote: string; input: CreatePull }; result: PullRequest };
  "reviews.act": { params: { projectId: string; remote: string; id: number; action: ReviewAction; body: string; head: string }; result: null };
  "reviews.publish": { params: { projectId: string; remote: string; branch: string }; result: null };
  "reviews.sync": { params: { projectId: string; remote: string; id: number }; result: { checkpointId: string } };
  "usage.report": { params: { projectId?: string; days: number }; result: UsageReport };

  "sessions.files.list": { params: { readonly sessionId: string; readonly path: string }; result: FileListing };
  "sessions.files.read": { params: { readonly sessionId: string; readonly path: string }; result: FileDocument };
  "sessions.files.save": { params: { readonly sessionId: string; readonly path: string; readonly text: string; readonly version: string }; result: FileDocument };
  "files.list": { params: { projectId: string; path: string }; result: FileListing };
  "files.read": { params: { projectId: string; path: string }; result: FileDocument };
  "files.save": { params: { projectId: string; path: string; text: string; version: string }; result: FileDocument };
  "terminal.open": { params: { projectId?: string; sessionId?: string; cols: number; rows: number }; result: TerminalSnapshot };
  "terminal.read": { params: { terminalId: string; after: number }; result: TerminalSnapshot };
  "terminal.write": { params: { terminalId: string; data: string }; result: null };
  "terminal.resize": { params: { terminalId: string; cols: number; rows: number }; result: null };
  "terminal.close": { params: { terminalId: string }; result: null };
  "browser.control": { params: { sessionId: string; request: BrowserRequest }; result: BrowserSnapshot };
  "accounts.list": { params: NoParams; result: readonly AccountView[] };
  "accounts.register": { params: RegisterAccountParams; result: AccountView };
  "accounts.select": { params: { readonly providerId: string; readonly accountId: string }; result: AccountView };
  "accounts.reauthenticate": {
    params: {
      readonly accountId: string;
      readonly credential: CredentialReferenceParams;
      readonly runtimeContextId?: string;
    };
    result: AccountView;
  };
  /** Providers with an interactive sign-in. */
  "auth.providers": { params: NoParams; result: readonly ConnectProviderView[] };
  /** Local readiness observation only; never starts login or changes availability. */
  "auth.diagnose": { params: { readonly providerId: string; readonly accountId?: string }; result: ProviderDiagnostic };
  /** Starts a sign-in; pass `accountId` to reconnect an existing account. */
  "auth.connect": { params: { readonly providerId: string; readonly accountId?: string; readonly useExistingLogin?: boolean }; result: ConnectView };
  "auth.submitCode": { params: { readonly connectId: string; readonly code: string }; result: null };
  "auth.cancel": { params: { readonly connectId: string }; result: null };
  /** Sign-ins in progress, for clients that open mid-flow. */
  "auth.active": { params: NoParams; result: readonly ConnectView[] };
  "projects.list": { params: NoParams; result: readonly ProjectView[] };
  /** `repositoryPath` selects a discovered repository; `sessionId` lists an isolated session's worktree. */
  "projects.branches": { params: { readonly projectId: string; readonly repositoryPath?: string; readonly sessionId?: string }; result: ProjectBranches };
  "projects.checkoutBranch": { params: { readonly projectId: string; readonly ref: string; readonly expectedHead: string; readonly repositoryPath?: string }; result: ProjectBranches };
  /**
   * One explicit Changes-panel Git operation (see `SourceControlAction`).
   * Fields beyond `kind` are required per kind: `paths` for stage/unstage/
   * discard, `message` for commit, `ref` for merge and `name` for
   * createBranch. `sessionId` targets an isolated session's worktree.
   */
  "projects.sourceControl": {
    params: {
      readonly projectId: string;
      readonly repositoryPath?: string;
      readonly sessionId?: string;
      readonly action: {
        readonly kind: SourceControlActionKind;
        readonly paths?: readonly string[];
        readonly message?: string;
        readonly amend?: boolean;
        readonly all?: boolean;
        readonly ref?: string;
        readonly name?: string;
      };
    };
    result: SourceControlResult;
  };
  /** `sessionId` reads an isolated session's worktree instead of the project folder. */
  "projects.changes": { params: { readonly projectId: string; readonly repositoryPath?: string; readonly sessionId?: string }; result: ProjectChanges };
  "projects.repositories": { params: { readonly projectId: string; readonly sessionId?: string } & RepositoryDiscoveryOptions; result: ProjectRepositories };
  "projects.create": {
    params: {
      readonly path: string;
      readonly startingRevision?: string;
    };
    result: ProjectView;
  };
  /** Omit `projectId` to list sessions from every project. */
  "sessions.list": { params: { readonly projectId?: string }; result: readonly SessionSummaryView[] };
  /** `workspaceMode` defaults to `shared`; `isolated` requires a Git repository with a commit. */
  "sessions.create": {
    params: { readonly projectId?: string; readonly title?: string; readonly workspaceMode?: WorkspaceMode };
    result: SessionView;
  };
  "skills.list": { params: { readonly sessionId: string; readonly runtimeId: string; readonly accountId: string }; result: import("@rack/core/execution/types").SkillCatalog };
  "sessions.attachProject": { params: { readonly sessionId: string; readonly projectId: string }; result: SessionView };
  "sessions.directory": { params: { readonly sessionId: string; readonly chatFiles?: boolean }; result: string };
  /** Allowed only before the session's first message. */
  "sessions.setWorkspaceMode": { params: { readonly sessionId: string; readonly mode: WorkspaceMode }; result: SessionView };
  /** Where the session runs, and the state of its isolated worktree. */
  "sessions.workspace": { params: { readonly sessionId: string }; result: SessionWorkspaceView };
  /** Removes an isolated session's worktree directory and keeps its branch. */
  "sessions.removeWorkspace": { params: { readonly sessionId: string; readonly force?: boolean }; result: SessionWorkspaceView };
  "sessions.get": { params: { readonly sessionId: string }; result: SessionView };
  "sessions.attachFiles": { params: { readonly sessionId: string; readonly paths: readonly string[] }; result: readonly SessionAttachment[] };
  "sessions.remove": { params: { readonly sessionId: string; readonly force?: boolean }; result: null };
  "sessions.discover": { params: { readonly projectId: string }; result: SessionDiscovery };
  "sessions.previewImport": {
    params: { readonly projectId: string; readonly sourceId: string; readonly nativeSessionId: string };
    result: ExternalSessionSnapshot;
  };
  "sessions.import": {
    params: { readonly projectId: string; readonly sourceId: string; readonly nativeSessionId: string };
    result: ImportSessionResult;
  };
  "runtimes.list": { params: NoParams; result: readonly RuntimeView[] };
  "models.list": { params: { readonly projectId?: string }; result: ModelCatalogView };
  "runtimes.capabilities": {
    params: { readonly runtimeId: string; readonly accountId: string };
    result: RuntimeCapabilities;
  };
  "runs.start": { params: StartRunParams; result: StartRunResult };
  "runs.list": { params: { readonly sessionId: string }; result: readonly RunView[] };
  "runs.journal": { params: { readonly runId: string }; result: readonly JournalEntryView[] };
  "runs.active": { params: NoParams; result: readonly ActiveRunView[] };
  "runs.respondToApproval": {
    params: { readonly runId: string; readonly approvalId: string; readonly decision: "allow" | "deny" };
    result: null;
  };
  "runs.cancel": { params: { readonly runId: string }; result: null };
  /**
   * Replaces the prompt of an earlier turn and runs it again with that
   * turn's original settings (account chosen by normal selection). The
   * edited turn and every later turn are superseded: hidden from the
   * conversation and from the agent's context, with their journals kept.
   * Files are not reverted. Refused with `session_busy` while the session
   * has an active run or workflow.
   */
  "runs.edit": { params: { readonly runId: string; readonly prompt: string }; result: StartRunResult };
  /*
   * Message queue: messages sent while a run is active wait in the
   * session's host-owned queue (`SessionView.queue`) and start in order
   * after the run completes. Every change is announced with
   * `sessions.changed`. Not available in workflow-bound or worker sessions.
   */
  /** Queues a message; starts it at once when the session is idle and the queue is not paused. */
  "queue.add": { params: QueueAddParams; result: QueueStartResult & { readonly item: QueuedMessageView } };
  /** Replaces a waiting message's text; its settings and attachments are kept. */
  "queue.update": { params: { readonly sessionId: string; readonly itemId: string; readonly prompt: string }; result: QueuedMessageView };
  "queue.remove": { params: { readonly sessionId: string; readonly itemId: string }; result: null };
  /** Stops the current run (if any) and starts this item next. */
  "queue.sendNow": { params: { readonly sessionId: string; readonly itemId: string }; result: QueueStartResult };
  /** Clears a pause; starts the oldest item when the session is idle. */
  "queue.resume": { params: { readonly sessionId: string }; result: QueueStartResult };
  "runs.respondToQuestions": { params: { readonly runId: string; readonly requestId: string; readonly response: UserQuestionResponse | null }; result: null };
  /*
   * Optional Timeline feature. A host assembled without Timeline answers
   * these with `feature_unavailable`.
   */
  /** Capability and opt-in state for one session; unsupported projects are not errors. */
  "timeline.status": { params: { readonly sessionId: string }; result: TimelineStatus };
  /** Enabling imports exact-session history and starts future capture; disabling keeps history. */
  "timeline.setEnabled": { params: { readonly sessionId: string; readonly enabled: boolean }; result: TimelineStatus };
  /** Visible checkpoints, oldest first, with current display filtering applied. */
  "timeline.checkpoints": { params: { readonly sessionId: string }; result: TimelineCheckpointList };
  /** Read-only HEAD history and saved snapshots from every session in the repository. */
  "timeline.projectHistory": { params: { readonly projectId: string; readonly mode?: "current" | "all" }; result: TimelineProjectHistory };
  "timeline.setProjectEnabled": { params: { readonly projectId: string; readonly enabled: boolean }; result: TimelineProjectHistory };
  /** Historical file tree and exact file contents; IDs are resolved by Timeline. */
  "timeline.snapshot": { params: TimelineSnapshotTarget; result: TimelineSnapshot };
  "timeline.snapshotHistory": { params: TimelineSnapshotTarget; result: TimelineSnapshotHistory };
  "timeline.snapshotFile": { params: TimelineSnapshotTarget & { readonly path: string }; result: TimelineSnapshotFileView };
  "timeline.projectFileDiff": {
    params: { readonly projectId: string; readonly checkpointId: string; readonly path: string };
    result: TimelineFileDiff;
  };
  /** Patch for one visible changed path of a checkpoint. */
  "timeline.fileDiff": {
    params: { readonly sessionId: string; readonly checkpointId: string; readonly path: string };
    result: TimelineFileDiff;
  };
}

export type HostCommand = keyof HostCommandMap;
export type CommandParams<C extends HostCommand> = HostCommandMap[C]["params"];
export type CommandResult<C extends HostCommand> = HostCommandMap[C]["result"];

const id = text({ maxLength: 256 });
const WORKSPACE_MODES: readonly WorkspaceMode[] = ["shared", "isolated"];
/** Every Changes-panel Git operation kind; the host maps each to a typed action. */
const SOURCE_CONTROL_ACTIONS: readonly SourceControlActionKind[] = [
  "stage", "stageAll", "unstage", "unstageAll", "discard", "discardAll", "commit",
  "fetch", "pull", "push", "sync", "merge", "abortMerge", "createBranch",
];
const credential = object({ id, providerId: id, method: id });

/** Runtime validators, one per command, typed against `HostCommandMap`. */
export const COMMAND_VALIDATORS: { readonly [C in HostCommand]: Validator<CommandParams<C>> } = {
  "orchestra.snapshot": empty,
  "orchestra.save": object({ definition: (value, path) => { try { return validateWorkflow(value); } catch (error) { throw new ContractValidationError(path, error instanceof Error ? error.message : "Invalid workflow."); } } }),
  "orchestra.remove": object({ workflowId: id }),
  "orchestra.bind": object({ sessionId: id, workflowId: optional(id) }),
  "orchestra.start": object({ input: (value, path): StartRunParams => COMMAND_VALIDATORS["runs.start"](value, path), workflowId: id }),
  "orchestra.control": object({ runId: id, action: oneOf(["pause", "resume", "approve", "stop"]) }),
  "orchestra.generate": object({ sessionId: id, generationId: id, description: text({ maxLength: 8000 }), model: object({ providerId: id, runtimeId: id, model: id, reasoningEffort: optional(text({ maxLength: 64 })) }) }),
  "orchestra.cancelGeneration": object({ generationId: id }),
  "reviews.accounts": object({ refresh: optional(boolean) }),
  "reviews.accountLoginBegin": object({ host: id }),
  "reviews.accountLoginFinish": object({ loginId: id }),
  "reviews.accountLoginCancel": object({ loginId: id }),
  "reviews.inbox": object({ accountId: optional(id), involvement: oneOf(["involved", "created", "review_requested", "assigned"]), query: text({ allowEmpty: true, maxLength: 512 }), state: oneOf(["open", "closed", "merged", "all"]), page: integer(1, 20) }),
  "reviews.inboxRepository": object({ accountId: id, repository: id, query: text({ allowEmpty: true, maxLength: 512 }), state: oneOf(["open", "closed", "merged", "all"]), page: integer(1, 1000) }),
  "reviews.inboxCreate": object({ accountId: id, repository: id, input: object({ title: text({ maxLength: 256 }), body: text({ allowEmpty: true, maxLength: 60000 }), source: id, target: id, draft: boolean }) }),
  "reviews.inboxDetail": object({ accountId: id, repository: id, id: integer(1, 2147483647) }),
  "reviews.inboxAct": object({ accountId: id, repository: id, id: integer(1, 2147483647), action: oneOf(["comment", "approve", "request_changes", "merge", "close", "reopen"]), body: text({ allowEmpty: true, maxLength: 60000 }), head: text({ maxLength: 64 }) }),
  "reviews.inboxSync": object({ accountId: id, repository: id, projectId: optional(id), id: integer(1, 2147483647) }),
  "reviews.repositories": object({ projectId: id }),
  "reviews.connect": object({ projectId: id, remote: id, token: text({ allowEmpty: true, maxLength: 4096 }) }),
  "reviews.list": object({ projectId: id, remote: id, query: text({ allowEmpty: true, maxLength: 512 }), state: oneOf(["open", "closed", "merged", "all"]), page: integer(1, 1000) }),
  "reviews.detail": object({ projectId: id, remote: id, id: integer(1, 2147483647) }),
  "reviews.create": object({ projectId: id, remote: id, input: object({ title: text({ maxLength: 256 }), body: text({ allowEmpty: true, maxLength: 60000 }), source: id, target: id, draft: boolean }) }),
  "reviews.act": object({ projectId: id, remote: id, id: integer(1, 2147483647), action: oneOf(["comment", "approve", "request_changes", "merge", "close", "reopen"]), body: text({ allowEmpty: true, maxLength: 60000 }), head: text({ maxLength: 64 }) }),
  "reviews.publish": object({ projectId: id, remote: id, branch: id }),
  "reviews.sync": object({ projectId: id, remote: id, id: integer(1, 2147483647) }),
  "usage.report": object({ projectId: optional(id), days: integer(1, 365) }),

  "sessions.files.list": object({ sessionId: id, path: text({ allowEmpty: true }) }),
  "sessions.files.read": object({ sessionId: id, path: text() }),
  "sessions.files.save": object({ sessionId: id, path: text(), text: text({ allowEmpty: true, maxLength: 1_048_576 }), version: text({ maxLength: 64 }) }),
  "files.list": object({ projectId: id, path: text({ allowEmpty: true }) }),
  "files.read": object({ projectId: id, path: text() }),
  "files.save": object({ projectId: id, path: text(), text: text({ allowEmpty: true, maxLength: 1_048_576 }), version: text({ maxLength: 64 }) }),
  "terminal.open": object({ projectId: optional(id), sessionId: optional(id), cols: integer(2, 500), rows: integer(1, 300) }),
  "terminal.read": object({ terminalId: id, after: integer(0, Number.MAX_SAFE_INTEGER) }),
  "terminal.write": object({ terminalId: id, data: text({ allowEmpty: true, maxLength: 65_536 }) }),
  "terminal.resize": object({ terminalId: id, cols: integer(2, 500), rows: integer(1, 300) }),
  "terminal.close": object({ terminalId: id }),
  "browser.control": object({ sessionId: id, request: object({
    action: oneOf(["state", "navigate", "back", "forward", "reload", "snapshot", "click", "type", "select", "press", "scroll", "agent", "close"]),
    actor: optional(oneOf(["user", "agent"])), url: optional(text()), ref: optional(text({ maxLength: 40 })), text: optional(text({ allowEmpty: true, maxLength: 10_000 })),
    x: optional(integer(-10_000, 10_000)), y: optional(integer(-10_000, 10_000)), enabled: optional(boolean),
  }) }),
  "accounts.list": empty,
  "accounts.register": object({
    providerId: id,
    providerAccountId: id,
    email: optional(text({ maxLength: 320 })),
    displayName: optional(text({ maxLength: 256 })),
    credential,
    runtimeContextId: id,
  }),
  "accounts.select": object({ providerId: id, accountId: id }),
  "accounts.reauthenticate": object({ accountId: id, credential, runtimeContextId: optional(id) }),
  "auth.providers": empty,
  "auth.diagnose": object({ providerId: text(), accountId: optional(text()) }),
  "auth.connect": object({ providerId: id, accountId: optional(id), useExistingLogin: optional(boolean) }),
  "auth.submitCode": object({ connectId: id, code: text({ maxLength: 4096 }) }),
  "auth.cancel": object({ connectId: id }),
  "auth.active": empty,
  "projects.list": empty,
  "projects.branches": object({ projectId: id, repositoryPath: optional(text()), sessionId: optional(id) }),
  "projects.checkoutBranch": object({ projectId: id, ref: text({ maxLength: 4096 }), expectedHead: text({ maxLength: 64 }), repositoryPath: optional(text()) }),
  "projects.sourceControl": object({ projectId: id, repositoryPath: optional(text()), sessionId: optional(id), action: object({
    kind: oneOf(SOURCE_CONTROL_ACTIONS),
    paths: optional(array(text({ maxLength: 4096 }), 1000)),
    message: optional(text({ allowEmpty: true, maxLength: 65_536 })),
    amend: optional(boolean), all: optional(boolean),
    ref: optional(text({ maxLength: 4096 })), name: optional(text({ maxLength: 255 })),
  }) }),
  "projects.changes": object({ projectId: id, repositoryPath: optional(text()), sessionId: optional(id) }),
  "projects.repositories": object({ projectId: id, sessionId: optional(id), rescan: optional(boolean), deep: optional(boolean), repositoryPath: optional(text()) }),
  "projects.create": object({
    path: text(),
    startingRevision: optional(id),
  }),
  "sessions.list": object({ projectId: optional(id) }),
  "sessions.create": object({ projectId: optional(id), title: optional(text({ maxLength: 256 })), workspaceMode: optional(oneOf(WORKSPACE_MODES)) }),
  "skills.list": object({ sessionId: id, runtimeId: id, accountId: id }),
  "sessions.attachProject": object({ sessionId: id, projectId: id }),
  "sessions.directory": object({ sessionId: id, chatFiles: optional(boolean) }),
  "sessions.setWorkspaceMode": object({ sessionId: id, mode: oneOf(WORKSPACE_MODES) }),
  "sessions.workspace": object({ sessionId: id }),
  "sessions.removeWorkspace": object({ sessionId: id, force: optional(boolean) }),
  "sessions.get": object({ sessionId: id }),
  "sessions.attachFiles": object({ sessionId: id, paths: array(text(), MAX_ATTACHMENTS) }),
  "sessions.remove": object({ sessionId: id, force: optional(boolean) }),
  "sessions.discover": object({ projectId: id }),
  "sessions.previewImport": object({ projectId: id, sourceId: id, nativeSessionId: id }),
  "sessions.import": object({ projectId: id, sourceId: id, nativeSessionId: id }),
  "runtimes.list": empty,
  "models.list": object({ projectId: optional(id) }),
  "runtimes.capabilities": object({ runtimeId: id, accountId: id }),
  "runs.start": object({
    attachmentIds: optional(array(id, MAX_ATTACHMENTS)),
    sessionId: id,
    projectId: optional(id),
    interactionMode: optional(oneOf(["normal", "plan"])),
    skillIds: optional(array(id, 16)),
    approvedPlanRunId: optional(id),
    providerId: id,
    runtimeId: id,
    accountId: optional(id),
    prompt: text({ maxLength: 200_000, allowEmpty: true }),
    model: optional(id),
    // Provider-defined level names (Codex reports free-form strings), so the
    // contract bounds the shape; the adapter checks support for the model.
    reasoningEffort: optional(text({ maxLength: 32 })),
    // Provider-defined option IDs (Codex service tiers are free-form strings).
    speed: optional(text({ maxLength: 64 })),
    permissionMode: oneOf(PERMISSION_MODES),
  }),
  "runs.edit": object({ runId: id, prompt: text({ maxLength: 200_000, allowEmpty: true }) }),
  "queue.add": object({
    sessionId: id,
    prompt: text({ maxLength: 200_000, allowEmpty: true }),
    attachmentIds: optional(array(id, MAX_ATTACHMENTS)),
    settings: object({
      providerId: id,
      runtimeId: id,
      accountId: optional(id),
      model: optional(id),
      reasoningEffort: optional(text({ maxLength: 32 })),
      speed: optional(text({ maxLength: 64 })),
      permissionMode: oneOf(PERMISSION_MODES),
      interactionMode: optional(oneOf(["normal", "plan"])),
      skillIds: optional(array(id, 16)),
    }),
  }),
  "queue.update": object({ sessionId: id, itemId: id, prompt: text({ maxLength: 200_000, allowEmpty: true }) }),
  "queue.remove": object({ sessionId: id, itemId: id }),
  "queue.sendNow": object({ sessionId: id, itemId: id }),
  "queue.resume": object({ sessionId: id }),
  "runs.list": object({ sessionId: id }),
  "runs.journal": object({ runId: id }),
  "runs.active": empty,
  "runs.respondToApproval": object({ runId: id, approvalId: id, decision: oneOf(["allow", "deny"]) }),
  "runs.cancel": object({ runId: id }),
  "runs.respondToQuestions": object({ runId: id, requestId: id, response: (value: unknown, path: string) => {
    try { return parseQuestionResponse(value); } catch (error) { throw new ContractValidationError(path, error instanceof Error ? error.message : "Invalid question answers."); }
  } }),
  "timeline.status": object({ sessionId: id }),
  "timeline.setEnabled": object({ sessionId: id, enabled: boolean }),
  "timeline.checkpoints": object({ sessionId: id }),
  "timeline.projectHistory": object({ projectId: id, mode: optional(oneOf(["current", "all"])) }),
  "timeline.setProjectEnabled": object({ projectId: id, enabled: boolean }),
  "timeline.snapshot": object({ scope: oneOf(["project", "session"]), contextId: id, checkpointId: id }),
  "timeline.snapshotHistory": object({ scope: oneOf(["project", "session"]), contextId: id, checkpointId: id }),
  "timeline.snapshotFile": object({ scope: oneOf(["project", "session"]), contextId: id, checkpointId: id, path: text({ maxLength: 4096 }) }),
  "timeline.projectFileDiff": object({ projectId: id, checkpointId: id, path: text() }),
  "timeline.fileDiff": object({ sessionId: id, checkpointId: id, path: text() }),
};

/** Narrows an untrusted method name to a known command. */
export function isHostCommand(value: unknown): value is HostCommand {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(COMMAND_VALIDATORS, value);
}

/** Validates untrusted parameters for a known command. */
export function validateCommandParams<C extends HostCommand>(command: C, params: unknown): CommandParams<C> {
  // Clients may send `undefined` for parameterless commands.
  const validator = COMMAND_VALIDATORS[command] as Validator<CommandParams<C>>;
  return validator(params ?? {}, "");
}
