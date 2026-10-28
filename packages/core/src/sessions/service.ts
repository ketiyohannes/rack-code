import { summarizeSession, type SessionSummary } from "./types.js";
import { randomUUID } from "node:crypto";

import { InvalidSessionError, SessionNotFoundError } from "./errors.js";
import type { SessionStore } from "./ports.js";
import { MAX_ATTACHMENTS, type AttachmentStore, type SessionAttachment } from "./attachments.js";
import {
  MAX_QUEUED_MESSAGES,
  type CreateSessionInput,
  type SessionImportSnapshot,
  type NativeContinuationReference,
  type QueuedMessage,
  type QueuedRunSettings,
  type QueuePauseReason,
  type SessionId,
  type SessionMessage,
  type SessionQueue,
  type SessionRecord,
  type SessionWorkspaceMode,
} from "./types.js";

export interface SessionsServiceOptions {
  readonly attachments?: AttachmentStore;
  /** Creates/resolves a private conversation workspace, separate from credentials. */
  readonly workspace?: (sessionId: string) => Promise<string>;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

/** Input for `SessionsService.enqueue`; timestamps and the ID are assigned here. */
export interface EnqueueMessageInput {
  readonly prompt: string;
  readonly attachmentIds?: readonly string[];
  readonly settings: QueuedRunSettings;
}

/**
 * Owns application sessions and keeps provider-native continuation IDs
 * subordinate to them.
 *
 * Every write is a read-modify-write of the whole record, so writes to one
 * session are serialized through a per-session lane (`mutate`). Without it,
 * two concurrent writers (for example execution appending the agent's reply
 * while the user edits the queue) would each read the same record and the
 * second save would silently discard the first one's change. Reads are not
 * serialized; they always observe a complete saved record. Writes to
 * different sessions still run concurrently.
 */
export class SessionsService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly attachments: AttachmentStore | undefined;
  /** Tail of the pending write chain per session; see `mutate`. */
  private readonly lanes = new Map<SessionId, Promise<unknown>>();

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
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      if (!projectId.trim()) throw new InvalidSessionError("Project ID is required.");
      if (session.projectId !== undefined) throw new InvalidSessionError("This session already belongs to a project.");
      const updated = { ...session, projectId, continuations: [], updatedAt: this.now().toISOString() };
      await this.store.save(updated);
      return updated;
    });
  }

  /**
   * Changes where a new session will run. Rejected once the session has any
   * message: providers tie native conversations to their working directory,
   * so moving an existing conversation would break resume (T3 Code locks the
   * choice the same way).
   */
  async setWorkspaceMode(sessionId: SessionId, mode: SessionWorkspaceMode): Promise<SessionRecord> {
    return this.mutate(sessionId, async () => {
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
    });
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
    await this.mutate(sessionId, async () => {
      await this.get(sessionId);
      await this.store.remove(sessionId);
    });
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
    if (input.content.trim() === "") {
      throw new InvalidSessionError("Session message content is required.");
    }
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
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
        ...(session.title === undefined && input.role === "user" ? { title: deriveTitle(input.content) } : {}),
        updatedAt: this.now().toISOString(),
      };
      await this.store.save(updated);
      return updated;
    });
  }

  async associateContinuation(
    sessionId: SessionId,
    continuation: NativeContinuationReference,
  ): Promise<SessionRecord> {
    return this.mutate(sessionId, async () => {
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
    });
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
    await this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      const continuations = session.continuations.filter((candidate) => !(candidate.runtimeId === reference.runtimeId
        && candidate.runtimeContextId === reference.runtimeContextId && candidate.nativeSessionId === reference.nativeSessionId));
      if (continuations.length === session.continuations.length) return;
      await this.store.save({ ...session, continuations, updatedAt: this.now().toISOString() });
    });
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
  // ---------------------------------------------------------------------------
  // Message queue
  //
  // The queue is owned by the session record (not by any window) so it
  // survives reloads and appears identically on every connected client.
  // These methods only store and order items; the host decides when an item
  // starts (see `afterRunSettled` in `queue-policy.ts`).

  /**
   * Appends a message to the end of the session's queue. A paused queue
   * stays paused. Fails when the item has neither text nor attachments or
   * the queue already holds `MAX_QUEUED_MESSAGES` items.
   */
  async enqueue(sessionId: SessionId, input: EnqueueMessageInput): Promise<QueuedMessage> {
    if (input.prompt.trim() === "" && (input.attachmentIds ?? []).length === 0) throw new InvalidSessionError("A queued message needs text or an attachment.");
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      const queue = session.queue ?? { items: [] };
      if (queue.items.length >= MAX_QUEUED_MESSAGES) throw new InvalidSessionError(`Up to ${MAX_QUEUED_MESSAGES} messages can wait in the queue.`);
      const timestamp = this.now().toISOString();
      const item: QueuedMessage = {
        id: this.createId(),
        prompt: input.prompt,
        ...((input.attachmentIds ?? []).length === 0 ? {} : { attachmentIds: [...input.attachmentIds!] }),
        settings: { ...input.settings, ...(input.settings.skillIds === undefined ? {} : { skillIds: [...input.settings.skillIds] }) },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.saveQueue(session, { ...queue, items: [...queue.items, item] });
      return item;
    });
  }

  /**
   * Puts an item taken with `takeQueued` back at the head of the queue with
   * its original ID and timestamps. Used when the host could not start it,
   * so a failed start never loses the user's message. Ignores the size limit
   * because the item was already counted before it was taken.
   */
  async restoreQueued(sessionId: SessionId, item: QueuedMessage): Promise<void> {
    await this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      const queue = session.queue ?? { items: [] };
      if (queue.items.some((candidate) => candidate.id === item.id)) return;
      await this.saveQueue(session, { ...queue, items: [item, ...queue.items] });
    });
  }

  /** Replaces a waiting item's text. Its settings and attachments are kept. */
  async updateQueued(sessionId: SessionId, itemId: string, prompt: string): Promise<QueuedMessage> {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      const queue = session.queue ?? { items: [] };
      const current = requireQueued(queue, itemId);
      if (prompt.trim() === "" && (current.attachmentIds ?? []).length === 0) throw new InvalidSessionError("A queued message needs text or an attachment.");
      const updated: QueuedMessage = { ...current, prompt, updatedAt: this.now().toISOString() };
      await this.saveQueue(session, { ...queue, items: queue.items.map((item) => item.id === itemId ? updated : item) });
      return updated;
    });
  }

  /** Removes a waiting item; an already started or removed item is an error. */
  async removeQueued(sessionId: SessionId, itemId: string): Promise<void> {
    await this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      const queue = session.queue ?? { items: [] };
      requireQueued(queue, itemId);
      await this.saveQueue(session, withoutItem(queue, itemId));
    });
  }

  /**
   * Removes and returns the item that should start: the named item, or the
   * oldest one. Returns `undefined` when there is nothing to take, so a
   * caller racing another client's removal starts nothing. The pause is
   * left as is; callers that start an item on the user's behalf clear it
   * with `resumeQueue`.
   */
  async takeQueued(sessionId: SessionId, itemId?: string): Promise<QueuedMessage | undefined> {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      const queue = session.queue ?? { items: [] };
      const item = itemId === undefined ? queue.items[0] : queue.items.find((candidate) => candidate.id === itemId);
      if (item === undefined) return undefined;
      await this.saveQueue(session, withoutItem(queue, item.id));
      return item;
    });
  }

  /**
   * Stops the queue from advancing on its own. A no-op for an empty queue,
   * because there is nothing to hold back. Clears a pending Send now: the
   * pause supersedes it, and the user resumes or sends explicitly.
   */
  async pauseQueue(sessionId: SessionId, reason: QueuePauseReason, error?: string): Promise<void> {
    await this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      const queue = session.queue;
      if (queue === undefined || queue.items.length === 0) return;
      const { sendNowItemId: _sendNow, pausedError: _error, ...rest } = queue;
      await this.saveQueue(session, { ...rest, pausedReason: reason, ...(error === undefined ? {} : { pausedError: error.slice(0, 500) }) });
    });
  }

  /** Clears a pause so the queue advances after the next completed run. */
  async resumeQueue(sessionId: SessionId): Promise<void> {
    await this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      const queue = session.queue;
      if (queue?.pausedReason === undefined) return;
      const { pausedReason: _reason, pausedError: _error, ...rest } = queue;
      await this.saveQueue(session, rest);
    });
  }

  /** Marks a waiting item to start as soon as the current run settles. */
  async requestSendNow(sessionId: SessionId, itemId: string): Promise<void> {
    await this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      const queue = session.queue ?? { items: [] };
      requireQueued(queue, itemId);
      await this.saveQueue(session, { ...queue, sendNowItemId: itemId });
    });
  }

  /**
   * Pauses every non-empty queue, including worker sessions. Called once at
   * host start: a run that was active when the previous process ended was
   * recovered as interrupted, and nothing should start without the user.
   */
  async pauseAllQueues(reason: QueuePauseReason): Promise<void> {
    for (const session of await this.store.list()) {
      if ((session.queue?.items.length ?? 0) > 0 && session.queue?.pausedReason === undefined) await this.pauseQueue(session.id, reason);
      else if (session.queue?.sendNowItemId !== undefined) await this.pauseQueue(session.id, reason);
    }
  }

  // ---------------------------------------------------------------------------
  // Editing an earlier message

  /**
   * Removes the turns in `supersede` from the conversation, for an edit of
   * an earlier user message (see `ExecutionService.start` with `rewind`).
   *
   * - Messages are cut at the first message that belongs to a superseded
   *   run (`metadata.runId`) or workflow run (`metadata.workflowRunId`);
   *   everything after it goes too. If no such message exists (the replaced
   *   runs never recorded one), no message is removed.
   * - A native continuation is kept only when the last message its thread
   *   has seen is still in the kept history. Any other thread has seen
   *   replaced turns, so it is dropped and the next run starts a fresh
   *   thread seeded with the kept history. Entries without a position
   *   (legacy records) are dropped for the same reason.
   * - The IDs are recorded in `supersededRunIds` so clients hide those turns.
   * - When the cut removes the first user message and the title is still the
   *   one derived from it, the title is cleared so the edited prompt (the
   *   next user message) sets a new one. A title chosen when the session was
   *   created does not match and is kept.
   *
   * Execution journals, attachments, Timeline snapshots and project files
   * are never touched: replaced runs stay auditable and files are not
   * reverted.
   */
  async rewind(sessionId: SessionId, supersede: readonly string[]): Promise<SessionRecord> {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      const replaced = new Set(supersede);
      const cut = session.messages.findIndex((message) =>
        replaced.has(message.metadata?.["runId"] ?? "") || replaced.has(message.metadata?.["workflowRunId"] ?? ""));
      const messages = cut === -1 ? session.messages : session.messages.slice(0, cut);
      const kept = new Set(messages.map((message) => message.id));
      const continuations = cut === -1
        ? session.continuations
        : session.continuations.filter((continuation) => continuation.seenThroughMessageId !== undefined && kept.has(continuation.seenThroughMessageId));
      const supersededRunIds = [...new Set([...(session.supersededRunIds ?? []), ...supersede])];
      const firstPrompt = session.messages.findIndex((message) => message.role === "user");
      const derivedTitleRemoved = cut !== -1 && firstPrompt >= cut
        && session.title === deriveTitle(session.messages[firstPrompt]!.content);
      const { title: _title, ...untitled } = session;
      const updated: SessionRecord = { ...(derivedTitleRemoved ? untitled : session), messages, continuations, supersededRunIds, updatedAt: this.now().toISOString() };
      await this.store.save(updated);
      return updated;
    });
  }

  /** Saves `queue`, dropping the field entirely when no items remain. */
  private async saveQueue(session: SessionRecord, queue: SessionQueue): Promise<void> {
    const { queue: _previous, ...rest } = session;
    await this.store.save({ ...rest, ...(queue.items.length === 0 ? {} : { queue }), updatedAt: this.now().toISOString() });
  }

  /**
   * Runs `operation` after every earlier write to the same session has
   * settled. A failed write releases the lane instead of blocking later
   * ones. Operations must not call another `mutate` for the same session,
   * or they would wait on themselves.
   */
  private async mutate<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.lanes.set(sessionId, current);
    try { return await current; }
    finally { if (this.lanes.get(sessionId) === current) this.lanes.delete(sessionId); }
  }
}

/** The title a session takes from its first user message. */
function deriveTitle(content: string): string {
  return content.replace(/\s+/g, " ").slice(0, 80);
}

/** The named waiting item, or an error explaining it is no longer waiting. */
function requireQueued(queue: SessionQueue, itemId: string): QueuedMessage {
  const item = queue.items.find((candidate) => candidate.id === itemId);
  if (item === undefined) throw new InvalidSessionError("This queued message was already sent or removed.");
  return item;
}

/** `queue` without one item; clears a Send now that named it. */
function withoutItem(queue: SessionQueue, itemId: string): SessionQueue {
  const { sendNowItemId, ...rest } = queue;
  return { ...rest, items: queue.items.filter((item) => item.id !== itemId), ...(sendNowItemId === undefined || sendNowItemId === itemId ? {} : { sendNowItemId }) };
}
