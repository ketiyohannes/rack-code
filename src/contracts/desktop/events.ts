/**
 * Facts the execution host broadcasts to every connected desktop client.
 *
 * Events describe things that already happened; clients never need to answer
 * them for a host operation to complete. A client that misses events can
 * rebuild state with the read commands (`runs.active`, `runs.journal`, the
 * list queries), so events are a freshness signal, not the source of truth.
 */
import type { ApprovalRequest, ConnectView, RunView, RuntimeEvent } from "./views.js";

export type HostEvent =
  /** A new run was accepted. `fallbackFromAccountId` is set when the selected account was not used. */
  | { readonly type: "run.started"; readonly run: RunView; readonly fallbackFromAccountId?: string }
  /** The run's persisted status changed while it is still active (for example queued to running). */
  | { readonly type: "run.updated"; readonly run: RunView }
  /**
   * One normalized runtime event. `index` is the zero-based position of the
   * event within the run, matching `ActiveRunView.events`.
   */
  | { readonly type: "run.event"; readonly runId: string; readonly index: number; readonly event: RuntimeEvent }
  /** An approval was answered by some client and is no longer pending. */
  | {
      readonly type: "run.approval_resolved";
      readonly runId: string;
      readonly approval: ApprovalRequest;
      readonly decision: "allow" | "deny";
    }
  /** Cancellation was requested; the run continues until a terminal event. */
  | { readonly type: "run.cancel_requested"; readonly runId: string }
  /** The run reached a persisted terminal state. */
  | { readonly type: "run.finished"; readonly run: RunView }
  /** A sign-in changed state (URL known, code needed, completed, failed, cancelled). */
  | { readonly type: "auth.updated"; readonly connect: ConnectView }
  /** Account records changed (registration, selection, availability, usage). */
  | { readonly type: "accounts.changed" }
  /** Project records changed, for example a new folder or writer lock. */
  | { readonly type: "projects.changed" }
  /** A project's sessions changed (new session, new message). */
  | { readonly type: "sessions.changed"; readonly projectId?: string | undefined; readonly sessionId: string }
  /** A saved conversation was removed; clients must evict its cached history. */
  | { readonly type: "sessions.removed"; readonly projectId?: string | undefined; readonly sessionId: string }
  /**
   * A session's Timeline checkpoints or settings changed (optional feature).
   * A freshness signal: clients re-read with `timeline.checkpoints`.
   */
  | { readonly type: "timeline.changed"; readonly sessionId: string }
  /**
   * Connection state of the execution host as seen by Electron main. Emitted
   * by main rather than the host, because a crashed host cannot report itself.
   */
  | { readonly type: "host.status"; readonly status: "ready" | "exited"; readonly detail?: string };

export type HostEventType = HostEvent["type"];
