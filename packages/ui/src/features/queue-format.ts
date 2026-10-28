/** Text for the queued-messages stack; kept free of DOM and icons so it is unit-testable. */
import type { QueuePauseReasonView, SessionQueueView } from "@rack/contracts";

/** Why the queue stopped, phrased for the stack's header. */
export function queuePauseText(reason: QueuePauseReasonView, error?: string): string {
  switch (reason) {
    case "run_failed": return "Paused because the last turn failed.";
    case "run_interrupted": return "Paused because the last turn was stopped.";
    case "run_unknown": return "Paused because the last turn ended without a clear result.";
    case "start_failed": return error === undefined || error.trim() === "" ? "Paused because the next message could not start." : `Paused: the next message could not start. ${error}`;
    case "host_restarted": return "Paused because Rack restarted.";
  }
}

/** One-line header: how many messages wait, or why they are held. */
export function queueHeading(queue: SessionQueueView): string {
  const count = queue.items.length;
  return `${count} queued message${count === 1 ? "" : "s"}`;
}
