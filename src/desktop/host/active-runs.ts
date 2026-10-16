/**
 * Host-side owner of in-flight `ExecutionHandle`s.
 *
 * The UI specification requires that a handle's `events` iterable is consumed
 * exactly once, that a renderer disconnect is not a cancellation, and that
 * pending approvals survive until some client answers them. Clients therefore
 * never hold handles; this class does. It:
 *
 * - drains each handle's events in the background and broadcasts them as
 *   indexed `run.event`s;
 * - keeps an in-memory copy of every event and every unanswered approval so
 *   a client that (re)connects mid-run can render an exact snapshot;
 * - forwards approval decisions and cancellation to the handle;
 * - emits `run.finished` with the persisted record once `completed` settles,
 *   then forgets the run. Durable history lives in the execution journal.
 *
 * Nothing here changes run state directly; ExecutionService remains the only
 * writer of run, attempt, and journal records.
 *
 * Optional observers (currently Timeline capture) receive each event after it
 * is recorded here and are finished after `run.finished` is emitted. They
 * can never delay, reorder, or fail the drain: their calls are guarded and
 * `finish` is awaited only so stop-on-exit waits for the final capture.
 */
import type { ExecutionHandle } from "../../core/execution/service.js";
import type { ApprovalRequest, RuntimeEvent, UserQuestionRequest, UserQuestionResponse } from "../../core/execution/types.js";
import type { HostEvent } from "../../contracts/desktop/events.js";
import type { ActiveRunView, RunView } from "../../contracts/desktop/views.js";
import type { TimelineRunObserver } from "../../features/timeline/index.js";
import { HostOperationError } from "./errors.js";

interface ActiveRun {
  readonly handle: ExecutionHandle;
  readonly sessionId: string;
  run: RunView;
  readonly events: RuntimeEvent[];
  readonly pendingApprovals: Map<string, ApprovalRequest>;
  readonly pendingQuestions: Map<string, UserQuestionRequest>;
  cancelRequested: boolean;
  readonly fallbackFromAccountId?: string;
  /** Optional per-run observer supplied by an assembled feature. */
  readonly observer?: TimelineRunObserver;
  /** Settles after `run.finished` has been emitted and the observer finished. */
  done: Promise<void>;
}

export interface ActiveRunsDependencies {
  /** Broadcasts an event to every connected client. */
  readonly emit: (event: HostEvent) => void;
  /** Loads the persisted run with attempts; used after status transitions. */
  readonly loadRun: (runId: string) => Promise<RunView>;
}

export class ActiveRuns {
  private readonly runs = new Map<string, ActiveRun>();

  constructor(private readonly dependencies: ActiveRunsDependencies) {}

  /**
   * Takes ownership of a freshly started handle and begins draining it. The
   * returned promise is not awaited by callers: the run outlives the request
   * that started it.
   */
  track(handle: ExecutionHandle, run: RunView, fallbackFromAccountId?: string, observer?: TimelineRunObserver): void {
    const active: ActiveRun = {
      handle,
      sessionId: run.sessionId,
      run,
      events: [],
      pendingApprovals: new Map(),
      pendingQuestions: new Map(),
      cancelRequested: false,
      ...(fallbackFromAccountId === undefined ? {} : { fallbackFromAccountId }),
      ...(observer === undefined ? {} : { observer }),
      done: Promise.resolve(),
    };
    // Register before draining so a fast run cannot finish (and delete
    // itself) before it was ever added.
    this.runs.set(run.id, active);
    active.done = this.drain(active);
  }

  /** Snapshots for every active run, used by `runs.active`. */
  list(): readonly ActiveRunView[] {
    return [...this.runs.values()].map((active) => ({
      run: active.run,
      events: [...active.events],
      pendingApprovals: [...active.pendingApprovals.values()],
      pendingQuestions: [...active.pendingQuestions.values()],
      cancelRequested: active.cancelRequested,
      ...(active.fallbackFromAccountId === undefined
        ? {}
        : { fallbackFromAccountId: active.fallbackFromAccountId }),
    }));
  }

  /** Number of active attempts per account, for the account view. */
  countByAccount(): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const active of this.runs.values()) {
      counts.set(active.run.accountId, (counts.get(active.run.accountId) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * Answers one pending approval. An unknown or already answered ID raises
   * `ApprovalNotFoundError` from the broker and leaves other approvals alone.
   */
  respondToApproval(runId: string, approvalId: string, decision: "allow" | "deny"): void {
    const active = this.require(runId);
    active.handle.respondToApproval(approvalId, decision);
    const approval = active.pendingApprovals.get(approvalId);
    active.pendingApprovals.delete(approvalId);
    if (approval !== undefined) {
      this.dependencies.emit({ type: "run.approval_resolved", runId, approval, decision });
    }
  }

  /** The core broker validates question IDs and choices before resolving the
   * native callback. All connected clients observe the resolution event.
   */
  async respondToQuestions(runId: string, requestId: string, response: UserQuestionResponse | null): Promise<void> {
    const active = this.require(runId);
    if (active.handle.respondToQuestions === undefined) throw new HostOperationError("invalid_input", "Question input is unavailable for this run.");
    await active.handle.respondToQuestions(requestId, response);
  }

  /**
   * Requests cancellation. Repeated calls are no-ops so the UI can treat
   * cancel as idempotent; the run stays active until the runtime reports a
   * terminal state.
   */
  async cancel(runId: string): Promise<void> {
    const active = this.require(runId);
    if (active.cancelRequested) {
      return;
    }
    active.cancelRequested = true;
    this.dependencies.emit({ type: "run.cancel_requested", runId });
    try { await active.handle.cancel(); }
    catch (error) { active.cancelRequested = false; throw error; }
  }

  /**
   * Stop-on-exit support: cancels every active run and waits until each has
   * persisted a terminal state or `timeoutMs` elapses, whichever comes first.
   * Returns the number of runs still active when the wait ended.
   */
  async cancelAll(timeoutMs: number): Promise<number> {
    // Start the deadline before asking providers to cancel: their acknowledgment
    // can hang too, so it must be included in the budget.
    await this.waitForStop([...this.runs.values()], timeoutMs);
    return this.runs.size;
  }

  /** Force removal waits for native cancellation AND durable execution settlement. */
  async cancelSession(sessionId: string, timeoutMs: number): Promise<void> {
    const runs = [...this.runs.values()].filter((active) => active.sessionId === sessionId);
    await this.waitForStop(runs, timeoutMs);
    if (runs.some((active) => this.runs.has(active.run.id))) throw new HostOperationError("session_busy", "The runtime has not stopped yet. Try stopping and deleting again.", { sessionId });
  }

  private async waitForStop(runs: readonly ActiveRun[], timeoutMs: number): Promise<void> {
    const stopping = Promise.allSettled(runs.map(async (active) => {
      // Even after a client already requested Stop, wait for the actual result.
      await this.cancel(active.run.id);
      await active.done;
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([stopping, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }

  private require(runId: string): ActiveRun {
    const active = this.runs.get(runId);
    if (active === undefined) {
      throw new HostOperationError("run_not_active", `Run '${runId}' is not active in this host.`, { runId });
    }
    return active;
  }

  private async drain(active: ActiveRun): Promise<void> {
    const { emit, loadRun } = this.dependencies;
    const runId = active.run.id;
    try {
      for await (const event of active.handle.events) {
        const index = active.events.length;
        active.events.push(event);
        if (event.type === "approval_request") {
          active.pendingApprovals.set(event.request.id, event.request);
        }
        if (event.type === "question_request") active.pendingQuestions.set(event.request.id, event.request);
        if (event.type === "question_resolved") active.pendingQuestions.delete(event.requestId);
        emit({ type: "run.event", runId, index, event });
        if (active.observer !== undefined) {
          try { active.observer.observe(event); } catch { /* Optional observers never affect the run. */ }
        }
        if (index === 0) {
          // By the first event the service has taken the project writer
          // lock and marked the run running; refresh both for clients.
          await this.refresh(active);
          emit({ type: "projects.changed" });
          emit({ type: "sessions.changed", projectId: active.run.projectId, sessionId: active.sessionId });
        }
        if (event.type === "availability") {
          emit({ type: "accounts.changed" });
        }
      }
    } catch {
      // The execution service records failures itself and always settles
      // `completed`; an iterator error here must not prevent that wait.
    }

    let finished: RunView;
    try {
      await active.handle.completed;
      finished = await loadRun(runId);
    } catch {
      // Fall back to the last known snapshot so clients still see the run
      // leave the active set; a later `runs.list` shows the stored record.
      finished = { ...active.run, status: "unknown", error: "Run stopped without a saved final outcome. Review its activity before continuing.",
        attempts: active.run.attempts.map((attempt) => attempt.status === "running" || attempt.status === "queued" ? { ...attempt, status: "unknown" } : attempt) };
    }
    this.runs.delete(runId);
    emit({ type: "run.finished", run: finished });
    emit({ type: "accounts.changed" });
    emit({ type: "projects.changed" });
    emit({ type: "sessions.changed", projectId: active.run.projectId, sessionId: active.sessionId });
    // Final observation ("Run settled") after the run is reported finished,
    // including failed and cancelled runs. Awaited so shutdown waits for it.
    await active.observer?.finish().catch(() => undefined);
  }

  private async refresh(active: ActiveRun): Promise<void> {
    try {
      active.run = await this.dependencies.loadRun(active.run.id);
      this.dependencies.emit({ type: "run.updated", run: active.run });
    } catch {
      // A transient read failure only delays the status label; the final
      // `run.finished` always carries the persisted record.
    }
  }
}
