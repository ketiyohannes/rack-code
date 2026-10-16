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
  readonly seenThroughMessageId?: string;
}

export interface SessionRecord {
  /** Retains access to the original file workspace after project attachment. */
  readonly originatedAsChat?: boolean;
  readonly id: SessionId;
  /** Absent for a standalone chat. */
  readonly projectId?: string;
  readonly title?: string;
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
  readonly id?: SessionId;
  /** Absent for a standalone chat. */
  readonly projectId?: string;
  readonly title?: string;
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
