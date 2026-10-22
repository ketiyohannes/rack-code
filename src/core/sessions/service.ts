import { summarizeSession, type SessionSummary } from "./types.js";
import { randomUUID } from "node:crypto";

import { InvalidSessionError, SessionNotFoundError } from "./errors.js";
import type { SessionStore } from "./ports.js";
import { MAX_ATTACHMENTS, type AttachmentStore, type SessionAttachment } from "./attachments.js";
import type {
  CreateSessionInput,
  SessionImportSnapshot,
  NativeContinuationReference,
  SessionId,
  SessionMessage,
  SessionRecord,
  SessionWorkspaceMode,
} from "./types.js";

export interface SessionsServiceOptions {
  readonly attachments?: AttachmentStore;
  /** Creates/resolves a private conversation workspace, separate from credentials. */
  readonly workspace?: (sessionId: string) => Promise<string>;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

/** Owns application sessions and keeps provider-native continuation IDs subordinate to them. */
export class SessionsService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly attachments: AttachmentStore | undefined;

  constructor(
    private readonly store: SessionStore,
    private readonly options: SessionsServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.attachments = options.attachments;
  }

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    if (input.workspaceMode === "isolated" && input.projectId === undefined) throw new InvalidSessionError("An isolated session needs a project.");
    if (input.projectId !== undefined && input.projectId.trim() === "") {
      throw new InvalidSessionError("Project ID is required.");
    }
    const parent = input.parentSessionId === undefined ? undefined : await this.get(input.parentSessionId);
    if (parent && (parent.parentSessionId !== undefined || parent.projectId !== input.projectId)) throw new InvalidSessionError("A worker must belong to a root conversation in the same project.");
    const timestamp = this.now().toISOString();
    const session: SessionRecord = {
      id: input.id ?? this.createId(),
      ...(parent === undefined ? {} : { parentSessionId: parent.id, workspaceMode: parent.workspaceMode ?? "shared" }),
      ...(input.projectId === undefined ? { originatedAsChat: true } : { projectId: input.projectId }),
      messages: [],
      continuations: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(parent !== undefined || input.workspaceMode === undefined || input.workspaceMode === "shared" ? {} : { workspaceMode: input.workspaceMode }),
    };
    await this.store.save(session);
    return session;
  }

  /** Resolves only persisted session IDs; the adapter controls directory names. */
  async workspace(sessionId: SessionId): Promise<string> {
    await this.get(sessionId);
    if (!this.options.workspace) throw new InvalidSessionError("Chat workspaces are unavailable.");
    const session = await this.get(sessionId);
    return this.options.workspace(session.parentSessionId ?? sessionId);
  }

  /** Attaching retains visible history, but starts native threads in the new cwd. */
  async attachProject(sessionId: SessionId, projectId: string): Promise<SessionRecord> {
    const session = await this.get(sessionId);
    if (!projectId.trim()) throw new InvalidSessionError("Project ID is required.");
    if (session.projectId !== undefined) throw new InvalidSessionError("This session already belongs to a project.");
    const updated = { ...session, projectId, continuations: [], updatedAt: this.now().toISOString() };
    await this.store.save(updated);
    return updated;
  }

  /**
   * Changes where a new session will run. Rejected once the session has any
   * message: providers tie native conversations to their working directory,
   * so moving an existing conversation would break resume (T3 Code locks the
   * choice the same way).
   */
  async setWorkspaceMode(sessionId: SessionId, mode: SessionWorkspaceMode): Promise<SessionRecord> {
    const session = await this.get(sessionId);
    if (mode === "isolated" && session.projectId === undefined) throw new InvalidSessionError("An isolated session needs a project.");
    if ((session.workspaceMode ?? "shared") === mode) return session;
    if (session.messages.length > 0) {
      throw new InvalidSessionError("The workspace can only be changed before the session's first message.");
    }
    const { workspaceMode: _previous, ...rest } = session;
    const updated: SessionRecord = {
      ...rest,
      ...(mode === "shared" ? {} : { workspaceMode: mode }),
      updatedAt: this.now().toISOString(),
    };
    await this.store.save(updated);
    return updated;
  }

  async get(sessionId: SessionId): Promise<SessionRecord> {
    const session = await this.store.get(sessionId);
    if (session === undefined) {
      throw new SessionNotFoundError(sessionId);
    }
    return session;
  }

  /** Removes Rack's conversation and continuation links. The host serializes
   * this with run starts and refuses active sessions. Audit logs, artifacts,
   * project files and provider-owned history have independent retention.
   */
  async remove(sessionId: SessionId): Promise<void> {
    await this.get(sessionId);
    await this.store.remove(sessionId);
  }

  /** Imports a batch atomically from the caller's perspective, without rewriting session history. */
  async attachFiles(sessionId: SessionId, paths: readonly string[]): Promise<readonly SessionAttachment[]> {
    await this.get(sessionId);
    if (this.attachments === undefined) throw new InvalidSessionError("Attachment storage is unavailable.");
    if (paths.length === 0 || paths.length > MAX_ATTACHMENTS) throw new InvalidSessionError(`Choose between 1 and ${MAX_ATTACHMENTS} files.`);
    const imported: SessionAttachment[] = [];
    try {
      for (const path of paths) imported.push(await this.attachments.importFile(sessionId, path));
      return imported;
    } catch (error) {
      await Promise.allSettled(imported.map((file) => this.attachments!.remove(sessionId, file.id)));
      throw error;
    }
  }

  /** Validates ownership before execution records a run or acquires a writer. */
  async resolveAttachments(sessionId: SessionId, ids: readonly string[]): Promise<readonly SessionAttachment[]> {
    if (ids.length === 0) return [];
    await this.get(sessionId);
    if (this.attachments === undefined) throw new InvalidSessionError("Attachment storage is unavailable.");
    if (ids.length > MAX_ATTACHMENTS || new Set(ids).size !== ids.length) throw new InvalidSessionError("Too many or duplicate attachments.");
    return Promise.all(ids.map((id) => this.attachments!.get(sessionId, id)));
  }

  /** Saves a complete import in one store mutation, without fabricated runs. */
  async importSnapshot(projectId: string, snapshot: SessionImportSnapshot): Promise<SessionRecord> {
    if (projectId.trim() === "") throw new InvalidSessionError("Project ID is required.");
    const importedAt = this.now().toISOString();
    const session: SessionRecord = {
      id: this.createId(), projectId, title: snapshot.session.title,
      createdAt: snapshot.session.createdAt, updatedAt: snapshot.session.updatedAt,
      messages: snapshot.messages.filter((message) => message.content.trim() !== "").map((message) => ({
        id: this.createId(), role: message.role, content: message.content,
        createdAt: message.createdAt ?? snapshot.session.createdAt,
        metadata: { imported: "true", ...(message.nativeMessageId === undefined ? {} : { nativeMessageId: message.nativeMessageId }),
          ...(message.presentation === undefined ? {} : { presentation: message.presentation }),
          ...(message.thinkingFormat === undefined ? {} : { thinkingFormat: message.thinkingFormat }) },
      })),
      continuations: [],
      importSource: { sourceId: snapshot.session.sourceId, providerName: snapshot.session.providerName,
        nativeSessionId: snapshot.session.nativeSessionId, importedAt },
    };
    await this.store.save(session);
    return session;
  }

  /**
   * Lists sessions, optionally restricted to one project, most recently
   * updated first so navigators show active conversations at the top.
   */
  async listSummaries(projectId?: string): Promise<readonly SessionSummary[]> {
    const summaries = this.store.listSummaries ? await this.store.listSummaries() : (await this.store.list()).map(summarizeSession);
    return summaries.filter((session) => session.parentSessionId === undefined && (projectId === undefined || session.projectId === projectId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async list(projectId?: string): Promise<readonly SessionRecord[]> {
    const sessions = await this.store.list();
    return sessions
      .filter((session) => session.parentSessionId === undefined && (projectId === undefined || session.projectId === projectId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async appendMessage(
    sessionId: SessionId,
    input: Omit<SessionMessage, "id" | "createdAt"> & { id?: string; createdAt?: string },
  ): Promise<SessionRecord> {
    const session = await this.get(sessionId);
    if (input.content.trim() === "") {
      throw new InvalidSessionError("Session message content is required.");
    }
    const message: SessionMessage = {
      id: input.id ?? this.createId(),
      role: input.role,
      content: input.content,
      createdAt: input.createdAt ?? this.now().toISOString(),
      ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
    };
    const updated: SessionRecord = {
      ...session,
      messages: [...session.messages, message],
      ...(session.title === undefined && input.role === "user" ? { title: input.content.replace(/\s+/g, " ").slice(0, 80) } : {}),
      updatedAt: this.now().toISOString(),
    };
    await this.store.save(updated);
    return updated;
  }

  async associateContinuation(
    sessionId: SessionId,
    continuation: NativeContinuationReference,
  ): Promise<SessionRecord> {
    const session = await this.get(sessionId);
    // Replace only the association for this runtime and account context, so
    // switching accounts and back resumes each account's own native thread.
    // Unscoped legacy entries for the runtime are dropped because their
    // owning context is unknown.
    const others = session.continuations.filter(
      (candidate) => candidate.runtimeId !== continuation.runtimeId
        || (candidate.runtimeContextId !== undefined
          && candidate.runtimeContextId !== continuation.runtimeContextId),
    );
    const updated: SessionRecord = {
      ...session,
      continuations: [...others, { ...continuation }],
      updatedAt: this.now().toISOString(),
    };
    await this.store.save(updated);
    return updated;
  }

  /**
   * Drops the association for one runtime and account context, for example
   * after the provider reported that the native thread cannot be resumed.
   * Only an entry naming `nativeSessionId` is removed, so a newer thread
   * associated concurrently is never discarded by a stale failure.
   */
  async removeContinuation(
    sessionId: SessionId,
    reference: Pick<NativeContinuationReference, "runtimeId" | "runtimeContextId" | "nativeSessionId">,
  ): Promise<void> {
    const session = await this.get(sessionId);
    const continuations = session.continuations.filter((candidate) => !(candidate.runtimeId === reference.runtimeId
      && candidate.runtimeContextId === reference.runtimeContextId && candidate.nativeSessionId === reference.nativeSessionId));
    if (continuations.length === session.continuations.length) return;
    await this.store.save({ ...session, continuations, updatedAt: this.now().toISOString() });
  }

  /**
   * Returns the native thread this runtime can resume for the given account
   * context. Resuming a thread from another context fails natively (Codex
   * reports "no rollout found for thread id"), so no match means the caller
   * starts a fresh native thread.
   */
  async continuation(
    sessionId: SessionId,
    runtimeId: string,
    runtimeContextId: string,
  ): Promise<NativeContinuationReference | undefined> {
    const session = await this.get(sessionId);
    return session.continuations.find((candidate) =>
      candidate.runtimeId === runtimeId && candidate.runtimeContextId === runtimeContextId);
  }
}
