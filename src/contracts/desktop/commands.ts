import type { AccountCatalog, ReviewAccount, InboxQuery, InboxResult, InboxTarget, RepositoryTarget, InboxDetail } from "../../features/pull-requests/index.js";
import type { ReviewRepository, PullDetail, PullList, PullRequest, CreatePull, PullState, ReviewAction } from "../../features/pull-requests/index.js";
import type { UsageReport } from "../../features/usage/index.js";
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
import { parseQuestionResponse, type UserQuestionResponse } from "../../core/execution/question-types.js";
import { MAX_ATTACHMENTS, type SessionAttachment } from "../../core/sessions/attachments.js";
import type { FileListing, FileDocument } from "../../features/files/index.js";
import type { TerminalSnapshot } from "../../features/terminal/types.js";
import type { BrowserRequest, BrowserSnapshot } from "../../features/browser/index.js";
import { integer } from "./validation.js";
import type { ProjectChanges, ProjectRepositories, RepositoryDiscoveryOptions } from "./views.js";
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
  readonly projectId: string;
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
}

type NoParams = Record<string, never>;

export interface HostCommandMap {
  "reviews.accounts": { params: { refresh?: boolean }; result: AccountCatalog };
  "reviews.accountConnect": { params: { host: string; token: string }; result: ReviewAccount };
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

  "files.list": { params: { projectId: string; path: string }; result: FileListing };
  "files.read": { params: { projectId: string; path: string }; result: FileDocument };
  "files.save": { params: { projectId: string; path: string; text: string; version: string }; result: FileDocument };
  "terminal.open": { params: { projectId: string; sessionId?: string; cols: number; rows: number }; result: TerminalSnapshot };
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
  "auth.connect": { params: { readonly providerId: string; readonly accountId?: string }; result: ConnectView };
  "auth.submitCode": { params: { readonly connectId: string; readonly code: string }; result: null };
  "auth.cancel": { params: { readonly connectId: string }; result: null };
  /** Sign-ins in progress, for clients that open mid-flow. */
  "auth.active": { params: NoParams; result: readonly ConnectView[] };
  "projects.list": { params: NoParams; result: readonly ProjectView[] };
  "projects.changes": { params: { readonly projectId: string; readonly repositoryPath?: string }; result: ProjectChanges };
  "projects.repositories": { params: { readonly projectId: string } & RepositoryDiscoveryOptions; result: ProjectRepositories };
  "projects.create": {
    params: {
      readonly path: string;
      readonly startingRevision?: string;
    };
    result: ProjectView;
  };
  /** Omit `projectId` to list sessions from every project. */
  "sessions.list": { params: { readonly projectId?: string }; result: readonly SessionSummaryView[] };
  "sessions.create": {
    params: { readonly projectId: string; readonly title?: string };
    result: SessionView;
  };
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
  "timeline.projectHistory": { params: { readonly projectId: string }; result: TimelineProjectHistory };
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
const credential = object({ id, providerId: id, method: id });

/** Runtime validators, one per command, typed against `HostCommandMap`. */
export const COMMAND_VALIDATORS: { readonly [C in HostCommand]: Validator<CommandParams<C>> } = {
  "reviews.accounts": object({ refresh: optional(boolean) }),
  "reviews.accountConnect": object({ host: id, token: text({ maxLength: 4096 }) }),
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

  "files.list": object({ projectId: id, path: text({ allowEmpty: true }) }),
  "files.read": object({ projectId: id, path: text() }),
  "files.save": object({ projectId: id, path: text(), text: text({ allowEmpty: true, maxLength: 1_048_576 }), version: text({ maxLength: 64 }) }),
  "terminal.open": object({ projectId: id, sessionId: optional(id), cols: integer(2, 500), rows: integer(1, 300) }),
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
  "auth.connect": object({ providerId: id, accountId: optional(id) }),
  "auth.submitCode": object({ connectId: id, code: text({ maxLength: 4096 }) }),
  "auth.cancel": object({ connectId: id }),
  "auth.active": empty,
  "projects.list": empty,
  "projects.changes": object({ projectId: id, repositoryPath: optional(text()) }),
  "projects.repositories": object({ projectId: id, rescan: optional(boolean), deep: optional(boolean), repositoryPath: optional(text()) }),
  "projects.create": object({
    path: text(),
    startingRevision: optional(id),
  }),
  "sessions.list": object({ projectId: optional(id) }),
  "sessions.create": object({ projectId: id, title: optional(text({ maxLength: 256 })) }),
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
    projectId: id,
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
  "timeline.projectHistory": object({ projectId: id }),
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
