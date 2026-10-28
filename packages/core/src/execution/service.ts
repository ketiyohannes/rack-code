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
import { renderHandoffContext, type HandoffKind } from "./handoff.js";
import type { NativeContinuationReference, SessionMessage } from "../sessions/types.js";

export interface StartRunInput {
  readonly attachmentIds?: readonly string[];
  readonly sessionId: string;
  /** Absent for a standalone chat. */
  readonly projectId?: string;
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
  readonly interactionMode?: "normal" | "plan";
  readonly skillIds?: readonly string[];
  readonly approvedPlanRunId?: string;
  /**
   * Starts this run as an edit of an earlier user message. `fromRunId` is
   * the run whose prompt is being replaced; it and every later run of the
   * session are superseded, together with `supersedeIds` (workflow runs,
   * which execution does not own, supplied by the host). History is cut
   * only after every other start check passed, so a rejected edit leaves
   * the conversation untouched. See `SessionsService.rewind`.
   */
  readonly rewind?: { readonly fromRunId: string; readonly supersedeIds?: readonly string[] };
}

export interface ExecutionHandle {
  readonly runId: string;
  readonly attemptId: string;
  readonly events: AsyncIterable<RuntimeEvent>;
  readonly completed: Promise<RunRecord>;
  respondToApproval(approvalId: string, decision: ApprovalDecision): void;
  respondToQuestions?(requestId: string, response: UserQuestionResponse | null): Promise<void>;
  cancel(): Promise<void>;
  /**
   * The `observedAt` journaled for an event this handle delivered (ISO 8601).
   * Hosts forward it with live events so a live view and a later journal
   * replay show identical timing. Optional for handles that keep no journal.
   */
  observedAt?(event: RuntimeEvent): string | undefined;
}

/** Host integration point after execution-directory preparation and before
 * native runtime startup. The run already has a cancelable queued handle.
 * Optional integrations must contain their own errors to remain non-blocking. */
export interface RunPreparation {
  readonly beforeRuntime?: (runId: string, signal: AbortSignal) => Promise<void>;
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
 * adapters. Each session runs one attempt at a time; several sessions of a
 * project may run concurrently (shared folder or isolated worktrees, see
 * `ProjectsService`).
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
  private readonly activeSessions = new Set<string>();
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

  /** Discovers through the selected account; paths supplied by clients are never trusted. */
  async listSkills(sessionId: string, runtimeId: string, accountId: string): Promise<import("./types.js").SkillCatalog> {
    const session = await this.sessions.get(sessionId);
    const account = await this.accounts.get(accountId);
    const runtime = this.runtimes.get(runtimeId);
    if (runtime.providerId !== undefined && runtime.providerId !== account.providerId) throw new AccountProviderMismatchError(accountId, runtime.providerId ?? runtimeId, account.providerId);
    const projectPath = session.projectId === undefined ? await this.sessions.workspace(sessionId) : (await this.projects.getProject(session.projectId)).path;
    return runtime.skills?.({ account: { accountId: account.id, providerId: account.providerId, credential: account.credential, runtimeContextId: account.runtimeContextId }, projectPath }) ?? { skills: [], errors: ["This runtime does not expose installed skills."] };
  }

  async start(input: StartRunInput, preparation: RunPreparation = {}): Promise<ExecutionHandle> {
    if (this.activeSessions.has(input.sessionId)) throw new InvalidSessionError("This conversation is already running.");
    this.activeSessions.add(input.sessionId);
    try { return await this.startReserved(input, preparation); }
    catch (error) { this.activeSessions.delete(input.sessionId); throw error; }
  }

  private async startReserved(input: StartRunInput, preparation: RunPreparation): Promise<ExecutionHandle> {
    await this.initialize();
    const session = await this.sessions.get(input.sessionId);
    const project = input.projectId === undefined ? undefined : await this.projects.getProject(input.projectId);
    if (session.projectId !== project?.id) throw new InvalidSessionError("The run's project must match its session's project.");
    if (project) input = { ...input, projectId: project.id };
    const projectPath = project?.path ?? await this.sessions.workspace(session.id);
    const attachments = await this.sessions.resolveAttachments(input.sessionId, input.attachmentIds ?? []);
    // Runs replaced by an earlier edit are no longer part of the
    // conversation, so they never count as the "latest" turn.
    const superseded = new Set(session.supersededRunIds ?? []);
    let approvedPlan: string | undefined;
    if (input.approvedPlanRunId !== undefined) {
      const plan = await this.getRun(input.approvedPlanRunId);
      const runs = (await this.store.listRuns(session.id)).filter((candidate) => !superseded.has(candidate.id));
      const newest = [...runs].reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (plan.sessionId !== session.id || plan.interactionMode !== "plan" || plan.status !== "completed" || !plan.result?.trim()
        || newest?.id !== plan.id || input.interactionMode === "plan") throw new InvalidSessionError("Choose the latest completed plan in this conversation.");
      approvedPlan = plan.result;
    }
    if (input.prompt.trim() === "" && attachments.length === 0 && approvedPlan === undefined) throw new InvalidSessionError("A prompt or attachment is required.");
    const replaced = input.rewind === undefined ? undefined : await this.supersededBy(session.id, superseded, input.rewind, input.approvedPlanRunId);
    const account = await this.resolveAccount(input);
    const runtime = this.runtimes.get(input.runtimeId);
    if (runtime.providerId !== undefined && runtime.providerId !== account.providerId) throw new AccountProviderMismatchError(account.id, runtime.providerId, account.providerId);
    const catalog = input.skillIds?.length ? await this.listSkills(input.sessionId, input.runtimeId, account.id) : { skills: [], errors: [] };
    const skills = (input.skillIds ?? []).map((id) => {
      const skill = catalog.skills.find((entry) => entry.id === id && entry.enabled);
      if (!skill) throw new InvalidSessionError("A selected skill is no longer available for this account and conversation. Refresh skills.");
      return skill;
    });
    if (skills.length > 16 || new Set(input.skillIds).size !== skills.length) throw new InvalidSessionError("Choose up to 16 distinct skills.");
    // Every check that can reject this start has passed; only now is it safe
    // to remove the replaced turns from the conversation.
    if (replaced !== undefined) await this.sessions.rewind(session.id, replaced);
    const effectivePermission = input.interactionMode === "plan" ? "read_only" : input.permissionMode;
    const runtimePrompt = approvedPlan === undefined ? input.prompt : `Implement this explicitly approved plan:\n\n${approvedPlan}\n\n${input.prompt}`;
    const runId = this.createId();
    const attemptId = this.createId();
    const timestamp = this.now().toISOString();
    const run: RunRecord = {
      id: runId,
      sessionId: input.sessionId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      prompt: input.prompt.trim() || (approvedPlan ? "Implement the approved plan." : input.prompt),
      ...(attachments.length === 0 ? {} : { attachments }),
      providerId: input.providerId,
      accountId: account.id,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      ...(input.speed === undefined ? {} : { speed: input.speed }),
      permissionMode: input.permissionMode,
      ...(input.interactionMode === undefined ? {} : { interactionMode: input.interactionMode }),
      ...(input.approvedPlanRunId === undefined ? {} : { approvedPlanRunId: input.approvedPlanRunId }),
      ...(input.rewind === undefined ? {} : { editOfRunId: input.rewind.fromRunId }),
      ...(skills.length === 0 ? {} : { skills }),
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
    // One timestamp per delivered event, taken before it is queued and used
    // for its journal row, so live clients and replays agree exactly.
    const observed = new WeakMap<RuntimeEvent, string>();
    const stamp = (event: RuntimeEvent): string => {
      const at = this.now().toISOString();
      observed.set(event, at);
      return at;
    };
    const approvals = new ApprovalBroker(
      queue,
      this.createId,
      stamp,
      async (event, observedAt) => {
        await this.store.appendJournal({ runId, attemptId, type: event.type, payload: event, observedAt });
      },
    );
    const questions = new QuestionBroker(this.createId, async (event) => {
      await this.store.appendJournal({ runId, attemptId, type: event.type, payload: event, observedAt: stamp(event) });
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
      input: { ...input, prompt: runtimePrompt, permissionMode: effectivePermission },
      skills,
      account,
      runtime,
      projectPath,
      workspaceMode: session.workspaceMode ?? "shared",
      workspaceSessionId: session.parentSessionId ?? session.id,
      preparation,
      run: currentRun,
      attempt: currentAttempt,
      controller,
      queue,
      stamp,
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
    const release = () => { this.activeRunIds.delete(runId); this.activeSessions.delete(input.sessionId); };
    void completed.then(release, release);

    return {
      runId,
      attemptId,
      events: queue,
      completed,
      respondToApproval: (approvalId, decision) => approvals.respond(approvalId, decision),
      respondToQuestions: (requestId, response) => questions.respond(requestId, response),
      cancel: stopRuntime,
      observedAt: (event) => observed.get(event),
    };
  }

  /**
   * The session's recorded conversation as an attributed, bounded context
   * block (see `handoff.ts`), or `undefined` when it has no messages. Lets
   * optional features such as orchestration brief fresh worker threads with
   * the same history, tool summaries and attribution a fresh native thread
   * receives, without reading execution storage themselves.
   */
  async conversationContext(sessionId: string): Promise<string | undefined> {
    const session = await this.sessions.get(sessionId);
    return this.handoffContext(sessionId, "history", session.messages);
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

  /**
   * Validates an edit and returns every run ID it replaces: the edited run,
   * each later run of the session not already superseded, and the host's
   * workflow run IDs. Rejects an edit of another session's run, of a turn
   * that was already replaced, and of a plan-approval implementation turn
   * (its prompt is generated from the approved plan, not typed by the user).
   * The new run itself is not created yet, so it is never in the list.
   */
  private async supersededBy(
    sessionId: string,
    superseded: ReadonlySet<string>,
    rewind: NonNullable<StartRunInput["rewind"]>,
    approvedPlanRunId: string | undefined,
  ): Promise<readonly string[]> {
    const from = await this.getRun(rewind.fromRunId);
    if (from.sessionId !== sessionId) throw new InvalidSessionError("Only messages in this conversation can be edited.");
    if (superseded.has(from.id)) throw new InvalidSessionError("This message was already replaced by a later edit.");
    if (from.approvedPlanRunId !== undefined || approvedPlanRunId !== undefined) throw new InvalidSessionError("A plan implementation turn cannot be edited.");
    // Transcript order (a stable sort by creation time), so runs created in
    // the same millisecond keep their recorded order.
    const runs = await this.listRuns(sessionId);
    const later = runs.slice(runs.findIndex((run) => run.id === from.id))
      .filter((run) => !superseded.has(run.id))
      .map((run) => run.id);
    return [...new Set([...later, ...(rewind.supersedeIds ?? [])])];
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
      workspaceMode,
      projectPath,
      run,
      attempt,
      controller,
      queue,
      stamp,
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
      const workflowPrompt = `${input.projectId === undefined ? "This is a general conversation. Help with questions, research and documents as well as code. Your working folder is this chat’s private file workspace. Save generated files there.\n\n" : ""}${input.interactionMode === "plan" ? "PLAN MODE: Research and propose a complete actionable plan. Do not implement or modify files, execute mutating commands, or perform external mutations. End with the plan for the user to review. Only the user can authorize a later implementation turn.\n\n" : ""}${attachedPrompt}`;
      if (input.projectId !== undefined) await this.projects.acquireWriter(input.projectId, attempt.id, { sessionId: input.sessionId, mode: workspaceMode });
      const directory = input.projectId === undefined ? { path: projectPath } : await this.projects.prepareExecutionDirectory(input.projectId, context.workspaceSessionId, workspaceMode);
      if (controller.signal.aborted) throw new Error("Run interrupted while preparing its workspace.");
      await context.preparation.beforeRuntime?.(run.id, controller.signal);
      if (controller.signal.aborted) throw new Error("Run interrupted before runtime startup.");
      currentRun = await this.updateRun(currentRun, "running");
      currentAttempt = await this.updateAttempt(currentAttempt, "running");
      onRun(currentRun);
      onAttempt(currentAttempt);
      // Explicit IDs let continuation markers name this run's messages
      // without re-reading the session after each append.
      const promptMessageId = this.createId();
      await this.sessions.appendMessage(input.sessionId, {
        id: promptMessageId,
        role: "user",
        content: promptWithAttachments(run.prompt, run.attachments ?? []),
        metadata: { runId: currentRun.id, attemptId: currentAttempt.id },
      });
      await this.accounts.markUsed(account.id);

      const appTools: readonly RuntimeAppTool[] = (this.tools?.(context.workspaceSessionId) ?? []).map((tool) => ({
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
      const runtimeInput: RuntimeRunInput = {
        runId: currentRun.id,
        attemptId: currentAttempt.id,
        sessionId: input.sessionId,
        account: {
          accountId: account.id,
          providerId: account.providerId,
          credential: account.credential,
          runtimeContextId: account.runtimeContextId,
        },
        projectPath: directory.path,
        ...("workspace" in directory && directory.workspace !== undefined ? { checkoutRoot: directory.workspace.checkoutRoot } : {}),
        prompt: workflowPrompt,
        interactionMode: input.interactionMode ?? "normal",
        ...(context.skills.length === 0 ? {} : { skills: context.skills }),
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
      const scope = { runtimeId: runtime.runtimeId, runtimeContextId: account.runtimeContextId };
      const continuation = await this.sessions.continuation(input.sessionId, scope.runtimeId, scope.runtimeContextId);
      // Everything Rack recorded before this run. The run's own prompt is
      // delivered separately as the current request.
      const prior = (await this.sessions.get(input.sessionId)).messages.filter((message) =>
        message.metadata?.["runId"] !== currentRun.id);
      const withContext = async (kind: HandoffKind, messages: readonly SessionMessage[]): Promise<RuntimeRunInput> => {
        const context = await this.handoffContext(input.sessionId, kind, messages);
        return context === undefined ? runtimeInput : { ...runtimeInput, prompt: `${context}\n\nCurrent request:\n${workflowPrompt}` };
      };
      // A fresh native thread (first turn, imports, account switches, project
      // attachment) receives the recent conversation. A resumed thread
      // receives only the turns other runtimes/accounts added since its own
      // last turn, so Codex -> Claude -> Codex resumes Codex knowing what
      // Claude did. When the thread's position is unknown, resuming would
      // silently drop work, so a fresh thread with full context is used.
      const unseen = continuation === undefined ? undefined : await this.unseenMessages(input.sessionId, prior, continuation);
      const resumed = continuation !== undefined && unseen !== undefined;
      if (controller.signal.aborted) throw new Error("Execution was interrupted.");
      const stream = resumed
        ? runtime.resumeRun({ ...(await withContext("handoff", unseen)), continuation: {
          nativeSessionId: continuation.nativeSessionId,
          ...(continuation.seenThroughMessageId === undefined ? {} : { seenThroughMessageId: continuation.seenThroughMessageId }),
        } })
        : runtime.startRun(await withContext("history", prior));
      // The native thread whose marker this run advances. A resumed thread is
      // known up front because some adapters do not re-announce it; a fresh
      // thread is only known once the adapter confirms it.
      let threadId: string | undefined;
      let threadReached = false;
      // Fallback is allowed only until the resumed turn shows any activity,
      // so work the provider already started is never repeated.
      let fallbackAvailable = resumed;

      // A provider can ignore abort while blocked in next(). Race the read,
      // discard late events, and finish native cleanup before releasing the writer.
      let iterator = stream[Symbol.asyncIterator]();
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
        if (fallbackAvailable && continuation !== undefined && event.type === "failed" && event.reason === "continuation_unavailable") {
          // The saved native thread cannot be opened (for example a Codex
          // thread whose first turn never started has no rollout). Finish the
          // adapter's cleanup for this attempt, forget the dead association
          // and continue the same attempt in a fresh thread with the full
          // conversation as context. The failure is journaled for audit but
          // not surfaced as the run's outcome.
          fallbackAvailable = false;
          try { await deadline(Promise.resolve(iterator.return?.()), this.cancelTimeoutMs + 1000); } catch { /* Best-effort cleanup; the next stream is independent. */ }
          await this.sessions.removeContinuation(input.sessionId, { ...scope, nativeSessionId: continuation.nativeSessionId });
          await this.store.appendJournal({
            runId: currentRun.id,
            attemptId: currentAttempt.id,
            type: "run_status",
            payload: { status: "running", reason: "continuation_unavailable", error: event.error },
            observedAt: this.now().toISOString(),
          });
          threadId = undefined;
          threadReached = false;
          if (controller.signal.aborted) throw new Error("Execution was interrupted.");
          iterator = runtime.startRun(await withContext("history", prior))[Symbol.asyncIterator]();
          streamIterator = iterator;
          continue;
        }
        if (event.type !== "native_session" && event.type !== "usage" && event.type !== "availability") fallbackAvailable = false;
        if (resumed && threadId === undefined && fallbackAvailable === false && event.type !== "failed" && event.type !== "interrupted") {
          // First activity on a resumed thread confirms it received this turn.
          threadId = continuation.nativeSessionId;
          threadReached = true;
        }
        await this.store.appendJournal({
          runId: currentRun.id,
          attemptId: currentAttempt.id,
          type: event.type,
          payload: event,
          observedAt: stamp(event),
        });
        queue.push(event);
        if (event.type === "message_delta") {
          appendAssistantText(event.text);
        } else if (event.type === "native_session") {
          currentAttempt = await this.updateAttempt(currentAttempt, currentAttempt.status, {
            nativeSessionId: event.nativeSessionId,
          });
          onAttempt(currentAttempt);
          // The adapter confirmed the thread after delivering this turn's
          // input, so the thread has seen everything through this prompt.
          threadId = event.nativeSessionId;
          threadReached = true;
          await this.sessions.associateContinuation(input.sessionId, {
            ...scope,
            nativeSessionId: event.nativeSessionId,
            seenThroughMessageId: promptMessageId,
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
      let seenThroughMessageId = promptMessageId;
      if (
        assistantContent !== undefined &&
        assistantContent.trim() !== ""
      ) {
        seenThroughMessageId = this.createId();
        await this.sessions.appendMessage(input.sessionId, {
          id: seenThroughMessageId,
          role: "assistant",
          content: assistantContent,
          metadata: { runId: currentRun.id, attemptId: currentAttempt.id },
        });
      }
      // The native thread produced (or received) this reply itself, so it
      // must not be handed back to it as another agent's work next turn.
      if (threadId !== undefined && threadReached) {
        await this.sessions.associateContinuation(input.sessionId, { ...scope, nativeSessionId: threadId, seenThroughMessageId });
      }
    } catch (error) {
      terminalStatus = isCancelled() ? "interrupted" : "failed";
      terminalError = error instanceof Error ? error.message : String(error);
      const failure: RuntimeEvent = isCancelled()
        ? { type: "interrupted" }
        : { type: "failed", error: terminalError };
      const failureObservedAt = stamp(failure);
      queue.push(failure);
      await this.store.appendJournal({
        runId: currentRun.id,
        attemptId: currentAttempt.id,
        type: failure.type,
        payload: failure,
        observedAt: failureObservedAt,
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
          if (input.projectId !== undefined) await this.projects.releaseWriter(input.projectId, currentAttempt.id);
        } catch {
          // Preserve the original run outcome; a stale lock is recoverable from
          // the project record and is surfaced by the next start attempt.
        }
        currentAttempt = await this.updateAttempt(currentAttempt, terminalStatus);
        if (!terminalResult?.trim() && getAssistantText().trim()) terminalResult = getAssistantText();
        currentRun = await this.updateRun(currentRun, terminalStatus, {
          ...((terminalResult ?? getAssistantText()).trim() === "" ? {} : { result: terminalResult ?? getAssistantText() }),
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

  /**
   * Messages in `prior` that the continuation's native thread has not seen,
   * or `undefined` when its position cannot be established (the caller then
   * starts a fresh thread). Records saved before `seenThroughMessageId` was
   * maintained fall back to the last message of a run whose attempt recorded
   * the same native session ID.
   */
  private async unseenMessages(
    sessionId: string,
    prior: readonly SessionMessage[],
    continuation: NativeContinuationReference,
  ): Promise<readonly SessionMessage[] | undefined> {
    let marker = continuation.seenThroughMessageId;
    if (marker === undefined) {
      const threadRuns = new Set<string>();
      for (const run of await this.store.listRuns(sessionId)) {
        for (const attemptId of run.attemptIds) {
          const attempt = await this.store.getAttempt(attemptId);
          if (attempt?.runtimeId === continuation.runtimeId && attempt.nativeSessionId === continuation.nativeSessionId) threadRuns.add(run.id);
        }
      }
      marker = [...prior].reverse().find((message) => threadRuns.has(message.metadata?.["runId"] ?? ""))?.id;
    }
    const index = marker === undefined ? -1 : prior.findIndex((message) => message.id === marker);
    return index === -1 ? undefined : prior.slice(index + 1);
  }

  /** Attributed, bounded description of `messages`; see `handoff.ts`. */
  private async handoffContext(sessionId: string, kind: HandoffKind, messages: readonly SessionMessage[]): Promise<string | undefined> {
    if (messages.length === 0) return undefined;
    const runs = new Map((await this.store.listRuns(sessionId)).map((run) => [run.id, run]));
    return renderHandoffContext(kind, messages, {
      run: (runId) => runs.get(runId),
      journal: (runId) => this.store.listJournal(runId),
    });
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
  readonly skills: readonly import("./types.js").RuntimeSkill[];
  readonly account: AccountRecord;
  readonly runtime: ReturnType<RuntimeRegistry["get"]>;
  /** Root workspace/tool owner; worker histories retain their own session ID. */
  readonly workspaceSessionId: string;
  /** Session workspace mode; resolved to a directory once the writer is held. */
  readonly workspaceMode: "shared" | "isolated";
  readonly preparation: RunPreparation;
  readonly projectPath: string;
  readonly run: RunRecord;
  readonly attempt: AttemptRecord;
  readonly controller: AbortController;
  readonly queue: AsyncQueue<RuntimeEvent>;
  /** Records and returns an event's journal time before it is queued (see `ExecutionHandle.observedAt`). */
  readonly stamp: (event: RuntimeEvent) => string;
  readonly approvals: ApprovalBroker;
  readonly questions: QuestionBroker;
  readonly onRun: (run: RunRecord) => void;
  readonly onAttempt: (attempt: AttemptRecord) => void;
  readonly getAssistantText: () => string;
  readonly appendAssistantText: (text: string) => void;
  readonly isCancelled: () => boolean;
  readonly stopRuntime: () => Promise<void>;
}

/**
 * Owns the pending approvals of one attempt.
 *
 * Both halves of an approval are run events: `approval_request` when the
 * adapter asks, and `approval_resolved` when a client answers. Each is
 * pushed to the client stream and journaled, so a client replaying the
 * journal (a reconnecting phone, a reload) sees the same decision a live
 * client saw. The resolution is published before the decision is released
 * to the adapter, which keeps it ahead of the call's eventual `tool_result`
 * in both the live stream and the journal.
 *
 * `close()` (cancellation or settlement) denies whatever is still pending
 * without publishing a resolution, because no person decided it; clients
 * read the run's terminal event to show those approvals as unanswered.
 */
class ApprovalBroker {
  private closed = false;
  private readonly pending = new Map<
    string,
    { resolve: (decision: ApprovalDecision) => void }
  >();
  /** Serializes resolution journaling so concurrent answers keep their order. */
  private resolutions: Promise<void> = Promise.resolve();

  constructor(
    private readonly queue: AsyncQueue<RuntimeEvent>,
    private readonly createId: () => string,
    /** Records the event's observation time; called before the event is queued. */
    private readonly stamp: (event: RuntimeEvent) => string,
    /** Journals a request or resolution with the time `stamp` returned. */
    private readonly journal: (event: Extract<RuntimeEvent, { type: "approval_request" | "approval_resolved" }>, observedAt: string) => Promise<void>,
  ) {}

  async request(request: Omit<ApprovalRequest, "id">): Promise<ApprovalDecision> {
    if (this.closed) return "deny";
    const full: ApprovalRequest = { ...request, id: this.createId() };
    const decision = new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(full.id, { resolve });
    });
    const event = { type: "approval_request", request: full } as const;
    const observedAt = this.stamp(event);
    this.queue.push(event);
    await this.journal(event, observedAt);
    return decision;
  }

  respond(approvalId: string, decision: ApprovalDecision): void {
    const pending = this.pending.get(approvalId);
    if (pending === undefined) {
      throw new ApprovalNotFoundError(approvalId);
    }
    this.pending.delete(approvalId);
    const event = { type: "approval_resolved", approvalId, decision } as const;
    const observedAt = this.stamp(event);
    this.queue.push(event);
    // The journal write is chained rather than awaited: `respond` stays
    // synchronous for the host, and the native callback must not wait on
    // storage. A failed write loses only this audit row, never the decision.
    this.resolutions = this.resolutions.then(() => this.journal(event, observedAt)).catch(() => undefined);
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
