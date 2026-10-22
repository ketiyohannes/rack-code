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
