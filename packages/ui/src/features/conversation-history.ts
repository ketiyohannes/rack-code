/**
 * Which turns belong to the selected conversation.
 *
 * Editing an earlier message supersedes that turn and every later one
 * (`SessionView.supersededRunIds`, written by the host). Superseded runs stay
 * in `runs.list` and keep their journals for audit, but they are no longer
 * part of the conversation: they are not rendered, never count as the
 * "latest" turn, and cannot block or seed the composer. Every view that
 * reasons about the conversation's turns reads them through these helpers,
 * so the rule lives in one place and is derived purely from host state.
 */
import type { WorkflowRun } from "@rack/features/orchestration/types";
import type { RunView } from "@rack/contracts";
import type { AppState } from "../store.js";

/** IDs of runs and workflow runs replaced by an edit in the selected session. */
export function supersededRunIds(state: Pick<AppState, "session">): ReadonlySet<string> {
  return new Set(state.session?.supersededRunIds ?? []);
}

/** The selected session's stored runs that are still part of the conversation, oldest first. */
export function visibleRuns(state: Pick<AppState, "session" | "runs">): readonly RunView[] {
  const superseded = supersededRunIds(state);
  return superseded.size === 0 ? state.runs : state.runs.filter((run) => !superseded.has(run.id));
}

/** The session's workflow runs that are still part of the conversation. */
export function visibleWorkflowRuns(state: Pick<AppState, "session" | "orchestra">, sessionId: string): readonly WorkflowRun[] {
  const superseded = supersededRunIds(state);
  return state.orchestra.runs.filter((run) => run.sessionId === sessionId && !superseded.has(run.id));
}

/**
 * Whether the user may edit this turn's message. Only the conversation's own
 * turns qualify: not a workflow agent's conversation, not a turn already
 * replaced, not a plan-approval implementation turn (its prompt is the
 * approved plan, not something the user typed) and not a turn the host never
 * started (no runtime recorded, so there is nothing to rerun it with).
 * A conversation that runs a workflow is excluded too, whether it is bound
 * to one or a workflow turn follows: an edit resends a plain agent turn and
 * would skip the workflow. This mirrors the host's `runs.edit` refusal.
 * Whether the session is idle is checked separately, because a busy session
 * disables Edit rather than hiding it.
 */
export function canEditTurn(state: Pick<AppState, "session" | "orchestra">, run: RunView): boolean {
  const session = state.session;
  return session !== undefined && run.sessionId === session.id && session.parentSessionId === undefined
    && !supersededRunIds(state).has(run.id) && run.approvedPlanRunId === undefined && run.attemptIds.length > 0
    && (run.prompt !== "" || (run.attachments?.length ?? 0) > 0)
    && state.orchestra.bindings[session.id] === undefined
    && !visibleWorkflowRuns(state, session.id).some((workflow) => workflow.createdAt >= run.createdAt);
}

/**
 * How many turns an edit of `run` replaces: the turn itself plus every later
 * turn of the conversation, workflow turns included (mirrors the host's
 * `runs.edit`, which supersedes everything created at or after the edited run).
 */
export function turnsReplacedByEdit(state: Pick<AppState, "session" | "runs" | "orchestra" | "live">, run: RunView): number {
  const sessionId = run.sessionId;
  const superseded = supersededRunIds(state);
  const ids = new Set<string>();
  for (const candidate of visibleRuns(state)) if (candidate.createdAt >= run.createdAt) ids.add(candidate.id);
  for (const live of Object.values(state.live)) {
    if (live.run.sessionId === sessionId && !superseded.has(live.run.id) && live.run.createdAt >= run.createdAt) ids.add(live.run.id);
  }
  for (const workflow of visibleWorkflowRuns(state, sessionId)) if (workflow.createdAt >= run.createdAt) ids.add(workflow.id);
  ids.add(run.id);
  return ids.size;
}
