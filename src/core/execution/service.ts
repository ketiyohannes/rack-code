import { randomUUID } from "node:crypto";

import type { AccountsService } from "../accounts/service.js";
import type { AccountRecord } from "../accounts/types.js";
import type { ProjectsService } from "../projects/service.js";
import type { SessionsService } from "../sessions/service.js";
import { InvalidSessionError } from "../sessions/errors.js";
import { promptWithAttachments } from "../sessions/attachments.js";
import { AccountProviderMismatchError } from "../accounts/errors.js";
import {
  ApprovalNotFoundError,
  AttemptNotFoundError,
  NoEligibleAccountError,
  RunNotFoundError,
} from "./errors.js";
import type { ExecutionStore } from "./ports.js";
import { AsyncQueue } from "../shared/async-queue.js";
import { RuntimeRegistry } from "./runtime-registry.js";
import type {
  UserQuestionResponse,
  ApprovalDecision,
  ApprovalRequest,
  AttemptRecord,
  JournalEntry,
  PermissionMode,
  RunRecord,
  RuntimeEvent,
  RuntimeRunInput,
} from "./types.js";
import { QuestionBroker } from "./question-broker.js";
import type { AppTool, RuntimeAppTool } from "./app-tools.js";

export interface StartRunInput {
  readonly attachmentIds?: readonly string[];
  readonly sessionId: string;
  readonly projectId: string;
  readonly providerId: string;
  readonly runtimeId: string;
  readonly accountId?: string;
  readonly prompt: string;
  readonly model?: string;
  /** Reasoning effort from the model catalog; omit for the provider default. */
  readonly reasoningEffort?: string;
  /** Speed option from the model catalog; omit for the provider default. */
  readonly speed?: string;
  readonly permissionMode: PermissionMode;
}

export interface ExecutionHandle {
  readonly runId: string;
  readonly attemptId: string;
  readonly events: AsyncIterable<RuntimeEvent>;
  readonly completed: Promise<RunRecord>;
  respondToApproval(approvalId: string, decision: ApprovalDecision): void;
  respondToQuestions?(requestId: string, response: UserQuestionResponse | null): Promise<void>;
  cancel(): Promise<void>;
}

export interface ExecutionServiceOptions {
  readonly now?: () => Date;
  readonly createId?: () => string;
  /** Grace period before forcibly closing an unresponsive runtime. */
  readonly cancelTimeoutMs?: number;
  /** Composition supplies optional capabilities; core never imports features. */
  readonly tools?: (sessionId: string) => readonly AppTool[];
}

/**
 * Coordinates accounts, sessions, projects, persistence, and runtime
 * adapters for one editing attempt at a time.
 *
 * Provider implementations only emit normalized events. This service owns the
 * durable run/attempt state, approval parking, session associations, and
 * project writer release on every terminal path.
 */
export class ExecutionService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly tools: ExecutionServiceOptions["tools"];
  private readonly cancelTimeoutMs: number;
  private initialization: Promise<void> | undefined;
  private readonly activeRunIds = new Set<string>();

  constructor(
    private readonly store: ExecutionStore,
    private readonly accounts: AccountsService,
    private readonly sessions: SessionsService,
    private readonly projects: ProjectsService,
    private readonly runtimes: RuntimeRegistry,
    options: ExecutionServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.tools = options.tools;
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? 1500;
  }

  /** Reconcile previous-process records exactly once, before any host queries or run starts. */
  initialize(): Promise<void> {
    return this.initialization ??= (async () => {
      await this.store.recoverInterruptedRuns(this.now().toISOString());
      await this.projects.recoverAbandonedWriters();
    })();
  }

  async start(input: StartRunInput): Promise<ExecutionHandle> {
    await this.initialize();
    // A session belongs to exactly one project. Reject mismatched references
    // before creating a run or acquiring a writer, including headless callers.
    const session = await this.sessions.get(input.sessionId);
    const project = await this.projects.getProject(input.projectId);
    if (session.projectId !== project.id) {
      throw new InvalidSessionError("The run's project must match its session's project.");
    }
    input = { ...input, projectId: project.id };
    const attachments = await this.sessions.resolveAttachments(input.sessionId, input.attachmentIds ?? []);
    if (input.prompt.trim() === "" && attachments.length === 0) throw new InvalidSessionError("A prompt or attachment is required.");
    const account = await this.resolveAccount(input);
    const runtime = this.runtimes.get(input.runtimeId);
    const runId = this.createId();
    const attemptId = this.createId();
    const timestamp = this.now().toISOString();
    const run: RunRecord = {
      id: runId,
      sessionId: input.sessionId,
      projectId: input.projectId,
      prompt: input.prompt,
      ...(attachments.length === 0 ? {} : { attachments }),
      providerId: input.providerId,
      accountId: account.id,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      ...(input.speed === undefined ? {} : { speed: input.speed }),
      permissionMode: input.permissionMode,
      status: "queued",
      attemptIds: [attemptId],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const attempt: AttemptRecord = {
      id: attemptId,
      runId,
      runtimeId: input.runtimeId,
      providerId: input.providerId,
      accountId: account.id,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.saveRun(run);
    await this.store.saveAttempt(attempt);
    await this.store.appendJournal({
      runId,
      attemptId,
      type: "run_started",
      payload: { providerId: input.providerId, accountId: account.id },
      observedAt: timestamp,
    });

    const controller = new AbortController();
    const queue = new AsyncQueue<RuntimeEvent>();
    const approvals = new ApprovalBroker(
      queue,
      this.createId,
      async (request) => {
        await this.store.appendJournal({
          runId,
          attemptId,
          type: "approval_request",
          payload: { type: "approval_request", request },
          observedAt: this.now().toISOString(),
        });
      },
    );
    const questions = new QuestionBroker(this.createId, async (event) => {
      await this.store.appendJournal({ runId, attemptId, type: event.type, payload: event, observedAt: this.now().toISOString() });
      queue.push(event);
    });
    let currentRun = run;
    let currentAttempt = attempt;
    let cancelled = false;
    let bufferedAssistantText = "";
    let cancellation: Promise<void> | undefined;
    const stopRuntime = (): Promise<void> => {
      if (cancellation !== undefined) return cancellation;
      cancelled = true;
      // Assign the shared promise before abort wakes the stream reader. Both
      // cancellation and finalization await the same bounded native cleanup.
      cancellation = Promise.resolve().then(async () => {
        try { await deadline(runtime.cancel({ attemptId, signal: controller.signal }), this.cancelTimeoutMs); }
        catch (error) { if (runtime.forceCancel === undefined) throw error; }
        if (runtime.forceCancel !== undefined) await deadline(runtime.forceCancel({ attemptId, signal: controller.signal }), this.cancelTimeoutMs + 1000);
      });
      controller.abort(); approvals.close();
      // A client may disconnect while cancellation is completing.
      void cancellation.catch(() => {});
      return cancellation;
    };

    this.activeRunIds.add(runId);
    const completed = this.consume({
      input,
      account,
      runtime,
      projectPath: project.path,
      run: currentRun,
      attempt: currentAttempt,
      controller,
      queue,
      approvals,
      questions,
      onRun: (next) => {
        currentRun = next;
      },
      onAttempt: (next) => {
        currentAttempt = next;
      },
      getAssistantText: () => bufferedAssistantText,
      appendAssistantText: (text) => {
        bufferedAssistantText += text;
      },
      isCancelled: () => cancelled || controller.signal.aborted,
      stopRuntime,
    });
    // Observe rejection immediately even if the host is still building the
    // start reply; callers can still await the original rejecting promise.
    void completed.then(() => this.activeRunIds.delete(runId), () => this.activeRunIds.delete(runId));

    return {
      runId,
      attemptId,
      events: queue,
      completed,
      respondToApproval: (approvalId, decision) => approvals.respond(approvalId, decision),
      respondToQuestions: (requestId, response) => questions.respond(requestId, response),
      cancel: stopRuntime,
    };
  }

  /** Whether this service still owns execution, independent of saved status. */
  isActive(runId: string): boolean { return this.activeRunIds.has(runId); }

  /** Public audit projection for analytics; excludes prompts and non-usage journal payloads. */
  async listRunUsage() { return this.store.listRunUsage(); }

  async getRun(runId: string): Promise<RunRecord> {
    const run = await this.store.getRun(runId);
    if (run === undefined) {
      throw new RunNotFoundError(runId);
    }
    return run;
  }

  /** Lists one session's runs oldest first, matching transcript order. */
  async listRuns(sessionId: string): Promise<readonly RunRecord[]> {
    const runs = await this.store.listRuns(sessionId);
    return [...runs].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getAttempt(attemptId: string): Promise<AttemptRecord> {
    const attempt = await this.store.getAttempt(attemptId);
    if (attempt === undefined) {
      throw new AttemptNotFoundError(attemptId);
    }
    return attempt;
  }

  /**
   * Returns the append-only journal for one run in sequence order. Clients
   * use it to rebuild a transcript after reconnecting instead of restarting
   * the attempt.
   */
  async listJournal(runId: string): Promise<readonly JournalEntry[]> {
    await this.getRun(runId);
    const entries = await this.store.listJournal(runId);
    return [...entries].sort((left, right) => left.sequence - right.sequence);
  }

  private async resolveAccount(input: StartRunInput): Promise<AccountRecord> {
    if (input.accountId !== undefined) {
      const account = await this.accounts.get(input.accountId);
      if (account.providerId !== input.providerId) {
        throw new AccountProviderMismatchError(account.id, input.providerId, account.providerId);
      }
      return account;
    }
    const account = await this.accounts.chooseEligible(input.providerId);
    if (account === undefined) {
      throw new NoEligibleAccountError(input.providerId);
    }
    return account;
  }

  private async consume(context: ConsumeContext): Promise<RunRecord> {
    const {
      input,
      account,
      runtime,
      projectPath,
      run,
      attempt,
      controller,
      queue,
      approvals,
      questions,
      onRun,
      onAttempt,
      getAssistantText,
      appendAssistantText,
      isCancelled, stopRuntime,
    } = context;
    let currentRun = run;
    let currentAttempt = attempt;
    // A cleanly exhausted provider stream without a terminal event is an
    // unknown outcome: the external process may have completed an action
    // immediately before disconnecting. Provider exceptions are still marked
    // failed in the catch block below.
    let terminalStatus: RunRecord["status"] = "unknown";
    let terminalResult: string | undefined;
    let terminalError: string | undefined;
    let streamIterator: AsyncIterator<RuntimeEvent> | undefined;

    try {
      const attachedPrompt = promptWithAttachments(input.prompt, run.attachments ?? []);
      await this.projects.acquireWriter(input.projectId, attempt.id);
      currentRun = await this.updateRun(currentRun, "running");
      currentAttempt = await this.updateAttempt(currentAttempt, "running");
      onRun(currentRun);
      onAttempt(currentAttempt);
      await this.sessions.appendMessage(input.sessionId, {
        role: "user",
        content: attachedPrompt,
        metadata: { runId: currentRun.id, attemptId: currentAttempt.id },
      });
      await this.accounts.markUsed(account.id);

      const appTools: readonly RuntimeAppTool[] = (this.tools?.(input.sessionId) ?? []).map((tool) => ({
        name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
        execute: async (arguments_) => {
          if (controller.signal.aborted) throw new Error("Run was interrupted.");
          if (tool.isMutation(arguments_)) {
            if (input.permissionMode === "read_only") throw new Error("Read only mode does not allow this browser action.");
            // Ask mode parks the application-owned action in the same broker
            // as native requests. Automatic mode leaves review to the runtime
            // before it invokes the authenticated MCP endpoint; adapters must
            // not allow-list these tools past the provider's native reviewer.
            if (input.permissionMode === "ask") {
              const decision = await approvals.request({ tool: tool.name, input: { action: arguments_ }, reason: "Allow this action in the shared browser?" });
              if (decision !== "allow" || controller.signal.aborted) throw new Error("Browser action was not approved.");
            }
          }
          return tool.execute(arguments_, controller.signal);
        },
      }));
      let runtimeInput: RuntimeRunInput = {
        runId: currentRun.id,
        attemptId: currentAttempt.id,
        sessionId: input.sessionId,
        account: {
          accountId: account.id,
          providerId: account.providerId,
          credential: account.credential,
          runtimeContextId: account.runtimeContextId,
        },
        projectPath,
        prompt: attachedPrompt,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
        ...(input.speed === undefined ? {} : { speed: input.speed }),
        permissionMode: input.permissionMode,
        signal: controller.signal,
        ...(appTools.length === 0 ? {} : { tools: appTools }),
        requestQuestions: (items, signal) => questions.request(items, signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal])),
        requestApproval: async (request) => {
          if (input.permissionMode === "read_only") {
            return "deny";
          }
          return approvals.request(request);
        },
      };
      // Scope the lookup to the selected account's runtime context: a manual
      // account switch or an automatic fallback must not resume a native
      // thread that only exists in another account's store.
      const continuation = await this.sessions.continuation(
        input.sessionId,
        runtime.runtimeId,
        account.runtimeContextId,
      );
      // An external snapshot has no resumable state in Rack's isolated account
      // context. Give a fresh native thread the recent visible conversation,
      // quoted as historical context; do not replay tool calls or copy secrets.
      if (continuation === undefined) {
        const session = await this.sessions.get(input.sessionId);
        if (session.importSource !== undefined) {
          const context = importedConversationContext(session.messages.filter((message) =>
            message.metadata?.["runId"] !== currentRun.id));
          runtimeInput = { ...runtimeInput, prompt: `${context}\n\nCurrent request:\n${attachedPrompt}` };
        }
      }
      if (controller.signal.aborted) throw new Error("Execution was interrupted.");
      const stream = continuation === undefined
        ? runtime.startRun(runtimeInput)
        : runtime.resumeRun({ ...runtimeInput, continuation });

      // A provider can ignore abort while blocked in next(). Race the read,
      // discard late events, and finish native cleanup before releasing the writer.
      const iterator = stream[Symbol.asyncIterator]();
      streamIterator = iterator;
      for (;;) {
        let next: IteratorResult<RuntimeEvent>;
        if (terminalStatus === "unknown") next = await nextOrAbort(iterator, controller.signal);
        else {
          // Allow trailing provider metadata, but a confirmed terminal event
          // must not require a stream to remain responsive forever.
          try { next = await deadline(nextOrAbort(iterator, controller.signal), this.cancelTimeoutMs); }
          catch (error) { if (controller.signal.aborted) throw error; break; }
        }
        if (next.done) break;
        const event = next.value;
        await this.store.appendJournal({
          runId: currentRun.id,
          attemptId: currentAttempt.id,
          type: event.type,
          payload: event,
          observedAt: this.now().toISOString(),
        });
        queue.push(event);
        if (event.type === "message_delta") {
          appendAssistantText(event.text);
        } else if (event.type === "native_session") {
          currentAttempt = await this.updateAttempt(currentAttempt, currentAttempt.status, {
            nativeSessionId: event.nativeSessionId,
          });
          onAttempt(currentAttempt);
          await this.sessions.associateContinuation(input.sessionId, {
            runtimeId: runtime.runtimeId,
            runtimeContextId: account.runtimeContextId,
            nativeSessionId: event.nativeSessionId,
          });
        } else if (event.type === "availability") {
          await this.accounts.updateAvailability(account.id, event);
        } else if (event.type === "completed") {
          terminalStatus = "completed";
          terminalResult = event.result;
        } else if (event.type === "failed") {
          terminalStatus = "failed";
          terminalError = event.error;
        } else if (event.type === "interrupted") {
          terminalStatus = "interrupted";
        }
      }

      if (isCancelled() && terminalStatus !== "completed" && terminalStatus !== "failed") {
        terminalStatus = "interrupted";
      }
      // Preserve partial assistant output even when a provider fails or is
      // interrupted; recovery must not require the exhausted runtime to
      // summarize work that was already streamed to the host.
      const assistantContent = getAssistantText().trim() === ""
        ? terminalResult
        : getAssistantText();
      if (
        assistantContent !== undefined &&
        assistantContent.trim() !== ""
      ) {
        await this.sessions.appendMessage(input.sessionId, {
          role: "assistant",
          content: assistantContent,
          metadata: { runId: currentRun.id, attemptId: currentAttempt.id },
        });
      }
    } catch (error) {
      terminalStatus = isCancelled() ? "interrupted" : "failed";
      terminalError = error instanceof Error ? error.message : String(error);
      const failure: RuntimeEvent = isCancelled()
        ? { type: "interrupted" }
        : { type: "failed", error: terminalError };
      queue.push(failure);
      await this.store.appendJournal({
        runId: currentRun.id,
        attemptId: currentAttempt.id,
        type: failure.type,
        payload: failure,
        observedAt: this.now().toISOString(),
      });
    } finally {
      try {
        approvals.close();
        if (isCancelled()) await stopRuntime();
        // Returning on errors preserves for-await's adapter cleanup semantics.
        // A terminal event followed by a hung iterator also gets native cleanup.
        if (streamIterator?.return !== undefined) {
          try { await deadline(streamIterator.return(), this.cancelTimeoutMs + 1000); }
          catch { if (!isCancelled()) await stopRuntime(); }
        }
        try { await questions.close(); } catch {
          // A failed answer-journal write must not leave the project locked.
          // Final run persistence below still reports its own storage failures.
        }
        try {
          await this.projects.releaseWriter(input.projectId, currentAttempt.id);
        } catch {
          // Preserve the original run outcome; a stale lock is recoverable from
          // the project record and is surfaced by the next start attempt.
        }
        currentAttempt = await this.updateAttempt(currentAttempt, terminalStatus);
        currentRun = await this.updateRun(currentRun, terminalStatus, {
          ...(terminalResult === undefined ? {} : { result: terminalResult }),
          ...(terminalError === undefined ? {} : { error: terminalError }),
        });
        onAttempt(currentAttempt);
        onRun(currentRun);
        await this.store.appendJournal({
          runId: currentRun.id,
          attemptId: currentAttempt.id,
          type: "run_status",
          payload: { status: terminalStatus, error: terminalError },
          observedAt: this.now().toISOString(),
        });
      } finally {
        // Storage/cleanup failures must still unblock ActiveRuns' event drain.
        queue.complete();
      }
    }
    return currentRun;
  }

  private async updateRun(
    run: RunRecord,
    status: RunRecord["status"],
    extra: Partial<Pick<RunRecord, "result" | "error">> = {},
  ): Promise<RunRecord> {
    const updated: RunRecord = {
      ...run,
      status,
      updatedAt: this.now().toISOString(),
      ...extra,
    };
    await this.store.saveRun(updated);
    return updated;
  }

  private async updateAttempt(
    attempt: AttemptRecord,
    status: AttemptRecord["status"],
    extra: Partial<Pick<AttemptRecord, "nativeSessionId">> = {},
  ): Promise<AttemptRecord> {
    const updated: AttemptRecord = {
      ...attempt,
      status,
      updatedAt: this.now().toISOString(),
      ...extra,
    };
    await this.store.saveAttempt(updated);
    return updated;
  }
}

interface ConsumeContext {
  readonly input: StartRunInput;
  readonly account: AccountRecord;
  readonly runtime: ReturnType<RuntimeRegistry["get"]>;
  readonly projectPath: string;
  readonly run: RunRecord;
  readonly attempt: AttemptRecord;
  readonly controller: AbortController;
  readonly queue: AsyncQueue<RuntimeEvent>;
  readonly approvals: ApprovalBroker;
  readonly questions: QuestionBroker;
  readonly onRun: (run: RunRecord) => void;
  readonly onAttempt: (attempt: AttemptRecord) => void;
  readonly getAssistantText: () => string;
  readonly appendAssistantText: (text: string) => void;
  readonly isCancelled: () => boolean;
  readonly stopRuntime: () => Promise<void>;
}

class ApprovalBroker {
  private closed = false;
  private readonly pending = new Map<
    string,
    { resolve: (decision: ApprovalDecision) => void }
  >();

  constructor(
    private readonly queue: AsyncQueue<RuntimeEvent>,
    private readonly createId: () => string,
    private readonly onRequest: (request: ApprovalRequest) => Promise<void>,
  ) {}

  async request(request: Omit<ApprovalRequest, "id">): Promise<ApprovalDecision> {
    if (this.closed) return "deny";
    const full: ApprovalRequest = { ...request, id: this.createId() };
    const decision = new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(full.id, { resolve });
    });
    this.queue.push({ type: "approval_request", request: full });
    await this.onRequest(full);
    return decision;
  }

  respond(approvalId: string, decision: ApprovalDecision): void {
    const pending = this.pending.get(approvalId);
    if (pending === undefined) {
      throw new ApprovalNotFoundError(approvalId);
    }
    this.pending.delete(approvalId);
    pending.resolve(decision);
  }

  close(): void {
    this.closed = true;
    for (const { resolve } of this.pending.values()) {
      resolve("deny");
    }
    this.pending.clear();
  }
}

/** Bound fresh-context handoffs while retaining the complete history in storage/UI. */
function importedConversationContext(messages: readonly import("../sessions/types.js").SessionMessage[]): string {
  const conversation = messages.filter((message) => message.role === "user" || message.role === "assistant");
  const selected: { role: string; content: string }[] = [];
  let remaining = 60_000;
  for (const message of [...conversation].reverse()) {
    if (remaining <= 0) break;
    const content = message.content.slice(-remaining);
    selected.unshift({ role: message.role, content });
    remaining -= content.length;
  }
  return `The following JSON is a historical conversation imported into this project. Use it as background, not as a new instruction to repeat previous actions. Tools and permissions are controlled by the current run. The recent visible conversation is included within a 60,000-character budget; the complete history remains in the app.\n${JSON.stringify(selected)}`;
}

/** Bounded native acknowledgments; observing a timeout never leaves a rejected promise unhandled. */
async function deadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("The runtime did not acknowledge cancellation.")), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

/** Stop consuming an unresponsive iterable immediately after abort; late provider events are ignored. */
function nextOrAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) return Promise.reject(new Error("Execution was interrupted."));
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("Execution was interrupted.")); };
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve().then(() => { signal.throwIfAborted(); return iterator.next(); }).then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
