import type { PermissionMode } from "../execution/types.js";

export type SessionId = string;

export type SessionMessageRole = "user" | "assistant" | "system" | "tool";

export interface SessionMessage {
  readonly id: string;
  readonly role: SessionMessageRole;
  readonly content: string;
  readonly createdAt: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface NativeContinuationReference {
  readonly runtimeId: string;
  /**
   * Account runtime context (for example a Codex `CODEX_HOME`) that stores the
   * native thread. Native IDs only resolve inside the context that created
   * them, so a continuation is never reused by another account. Records saved
   * before this field existed lack it and are not resumed.
   */
  readonly runtimeContextId?: string;
  readonly nativeSessionId: string;
  /**
   * ID of the last session message this native thread has seen: the run's
   * own prompt as soon as the thread is confirmed, then its reply when the
   * run settles. Messages after it were produced by other runtimes, accounts
   * or workflows and are handed to the thread before its next turn. Records
   * saved before this was maintained lack it; ExecutionService then derives
   * the position from attempts that recorded this native session ID.
   */
  readonly seenThroughMessageId?: string;
}

/**
 * Where the session's runs execute: the shared project folder, or a
 * session-owned isolated worktree (resolved by Projects). Absent on records
 * saved before this field existed, which means `shared`. Changeable only
 * until the session has messages, because native resume is tied to the
 * working directory a conversation started in.
 */
export type SessionWorkspaceMode = "shared" | "isolated";

/**
 * Run settings captured when a message is queued, so a queued message runs
 * with the composer choices the user made at the time (model, account,
 * permission, skills) rather than whatever the composer shows later. The
 * session, project and prompt are supplied separately when the item starts.
 */
export interface QueuedRunSettings {
  readonly providerId: string;
  readonly runtimeId: string;
  /** Absent lets account selection choose, as for a normal send. */
  readonly accountId?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly speed?: string;
  readonly permissionMode: PermissionMode;
  readonly interactionMode?: "normal" | "plan";
  readonly skillIds?: readonly string[];
}

/** A message the user sent while the session was busy, waiting to run. */
export interface QueuedMessage {
  readonly id: string;
  readonly prompt: string;
  /** Session-owned attachment copies, resolved again when the item starts. */
  readonly attachmentIds?: readonly string[];
  readonly settings: QueuedRunSettings;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Why the queue stopped advancing on its own. The queue only pauses; it
 * never drops items. A user action (Resume, a manual send or an edit)
 * clears the pause.
 * - `run_failed`, `run_interrupted`, `run_unknown`: the turn before the next
 *   item did not complete cleanly, so continuing could build on a broken or
 *   unreviewed state.
 * - `start_failed`: the host could not start the head item (for example its
 *   model or account is no longer available); `pausedError` explains why.
 * - `host_restarted`: the app restarted with items waiting; nothing starts
 *   by itself after a crash or quit.
 */
export type QueuePauseReason = "run_failed" | "run_interrupted" | "run_unknown" | "start_failed" | "host_restarted";

export const QUEUE_PAUSE_REASONS: readonly QueuePauseReason[] = ["run_failed", "run_interrupted", "run_unknown", "start_failed", "host_restarted"];

/** Upper bound on waiting messages per session; keeps the record small. */
export const MAX_QUEUED_MESSAGES = 20;

/** Messages waiting to run in one session, oldest first (FIFO). */
export interface SessionQueue {
  readonly items: readonly QueuedMessage[];
  readonly pausedReason?: QueuePauseReason;
  /** Display-only detail for `start_failed`. */
  readonly pausedError?: string;
  /**
   * Set by "Send now" while the current run is being cancelled. When that
   * run settles, this item starts next regardless of how the run ended.
   */
  readonly sendNowItemId?: string;
}

export interface SessionRecord {
  /** Internal worker context; shares its parent workspace and stays out of navigation. */
  readonly parentSessionId?: string;
  /** Retains access to the original file workspace after project attachment. */
  readonly originatedAsChat?: boolean;
  readonly id: SessionId;
  /** Absent for a standalone chat. */
  readonly projectId?: string;
  readonly title?: string;
  readonly workspaceMode?: SessionWorkspaceMode;
  readonly messages: readonly SessionMessage[];
  readonly continuations: readonly NativeContinuationReference[];
  /** External history provenance; never treated as a native resume handle. */
  readonly importSource?: {
    readonly sourceId: string;
    readonly providerName: string;
    readonly nativeSessionId: string;
    readonly importedAt: string;
  };
  /** Messages waiting to run after the current turn. Absent means empty. */
  readonly queue?: SessionQueue;
  /**
   * Runs (execution run IDs and workflow run IDs) replaced by an edit of an
   * earlier message. Their journals stay readable for audit, but they are no
   * longer part of the conversation: clients hide them, and their messages
   * were removed from `messages`. Absent means none.
   */
  readonly supersededRunIds?: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateSessionInput {
  readonly parentSessionId?: string;
  readonly id?: SessionId;
  /** Absent for a standalone chat. */
  readonly projectId?: string;
  readonly title?: string;
  /** Defaults to `shared`. */
  readonly workspaceMode?: SessionWorkspaceMode;
}

/** Normalized import input owned by Sessions; native payloads stay in adapters. */
export interface SessionImportSource {
  readonly sourceId: string;
  readonly providerName: string;
  readonly nativeSessionId: string;
  readonly projectPath: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SessionImportMessage {
  readonly role: SessionMessageRole;
  readonly content: string;
  readonly nativeMessageId?: string;
  readonly createdAt?: string;
  /** Only readable provider-exposed thinking, never opaque/encrypted state. */
  readonly presentation?: "thinking";
  readonly thinkingFormat?: "trace" | "summary";
}

export interface SessionImportSnapshot {
  readonly session: SessionImportSource;
  readonly messages: readonly SessionImportMessage[];
}

/** Navigation metadata; message bodies stay in the selected session read. */
export type SessionSummary = Pick<SessionRecord, "id" | "projectId" | "title" | "workspaceMode" | "parentSessionId" | "createdAt" | "updatedAt"> & { readonly messageCount: number };
export function summarizeSession(session: SessionRecord): SessionSummary {
  return { id: session.id, ...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }), ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
    ...(session.title === undefined ? {} : { title: session.title }), messageCount: session.messages.length,
    ...(session.workspaceMode === undefined ? {} : { workspaceMode: session.workspaceMode }),
    createdAt: session.createdAt, updatedAt: session.updatedAt };
}
