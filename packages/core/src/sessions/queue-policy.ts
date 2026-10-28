import type { QueuePauseReason, SessionQueue } from "./types.js";

/** Terminal and non-terminal run outcomes the policy distinguishes. */
export type SettledRunStatus = "queued" | "running" | "completed" | "failed" | "interrupted" | "unknown";

/** What the host should do with a session's queue after one of its runs settled. */
export type QueueDecision =
  | { readonly action: "start"; readonly itemId: string }
  | { readonly action: "pause"; readonly reason: QueuePauseReason }
  | { readonly action: "none" };

/**
 * Decides how a session's queue advances when a run of that session settles.
 * Pure, so the rule is unit-tested without a host:
 *
 * - An empty queue does nothing.
 * - A pending "Send now" wins over every outcome: the user explicitly asked
 *   to replace the current turn with that item, and an interrupted run is
 *   exactly what Send now produces. If the named item was removed meanwhile,
 *   the normal rules below apply.
 * - A queue that is already paused stays paused until the user acts.
 * - A completed run starts the oldest item.
 * - A failed, interrupted (including a user Stop) or unknown run pauses the
 *   queue instead of continuing on top of a state the user has not reviewed.
 * - A non-terminal status (never expected here) does nothing.
 */
export function afterRunSettled(status: SettledRunStatus, queue: SessionQueue | undefined): QueueDecision {
  if (queue === undefined || queue.items.length === 0) return { action: "none" };
  if (queue.sendNowItemId !== undefined && queue.items.some((item) => item.id === queue.sendNowItemId)) {
    return { action: "start", itemId: queue.sendNowItemId };
  }
  if (queue.pausedReason !== undefined) return { action: "none" };
  switch (status) {
    case "completed": return { action: "start", itemId: queue.items[0]!.id };
    case "failed": return { action: "pause", reason: "run_failed" };
    case "interrupted": return { action: "pause", reason: "run_interrupted" };
    case "unknown": return { action: "pause", reason: "run_unknown" };
    default: return { action: "none" };
  }
}
