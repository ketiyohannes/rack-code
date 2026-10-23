/** Read-only projection of an individual worker's current activity. Inputs are
 * normalized execution snapshots, never renderer state or provider protocols.
 * This does not consume events, schedule work, or infer timing from silence. */
import type { RunStatus, RuntimeEvent } from "@rack/core/execution/types";
import type { WorkflowWorker } from "./types.js";

/** Structural subset of the existing live execution snapshot. Pending broker
 * state is authoritative: approval events alone cannot prove a request is open. */
export interface WorkerExecutionActivity {
  readonly run: { readonly status: RunStatus };
  readonly events: readonly RuntimeEvent[];
  readonly pendingApprovals: readonly { readonly id: string }[];
  readonly pendingQuestions?: readonly { readonly id: string }[];
  readonly cancelRequested: boolean;
}

/** Presentation may choose its own layout/icons from kind. Labels contain only
 * bounded tool names, never commands, arguments, output, or model reasoning. */
export interface WorkerActivity {
  readonly kind: "queued" | "working" | "tool" | "responding" | "waiting_approval"
    | "waiting_input" | "stopping" | "finished" | "unavailable";
  readonly label: string;
  /** Number of currently attributable tool calls, only present for tool activity. */
  readonly activeToolCount?: number;
}

/** Derive activity for one execution (including revisions and parallel workers).
 * Settlement wins over stale input/tools, then cancellation, then pending input.
 * Missing execution history never establishes that a worker is actively working. */
export function projectWorkerActivity(
  worker: Pick<WorkflowWorker, "status">,
  execution?: WorkerExecutionActivity,
): WorkerActivity {
  if (worker.status === "completed") return { kind: "finished", label: "Completed" };
  if (worker.status === "failed") return { kind: "finished", label: "Needs attention" };
  if (worker.status === "stopped") return { kind: "finished", label: "Stopped" };
  if (!execution) return worker.status === "queued"
    ? { kind: "queued", label: "Waiting" }
    : { kind: "unavailable", label: "Activity unavailable" };

  const settled = terminalActivity(execution.run.status);
  if (settled) return settled;
  const tools = new Map<string, string>();
  let responding = false;
  let terminal: WorkerActivity | undefined;
  for (const event of execution.events) {
    switch (event.type) {
      case "completed": case "failed": case "interrupted":
        terminal = terminalActivity(event.type);
        break;
      case "tool_request":
        responding = false;
        // Without correlation, even a subsequent result cannot be attributed
        // safely. Discard the active attribution and show a generic fallback;
        // this does not assert that any previous call completed.
        if (!event.toolCallId) tools.clear();
        else {
          tools.delete(event.toolCallId);
          tools.set(event.toolCallId, event.tool);
        }
        break;
      case "tool_result":
        responding = false;
        if (!event.toolCallId) tools.clear();
        else tools.delete(event.toolCallId);
        break;
      case "message_delta": responding = true; break;
      case "thinking_delta": responding = false; break;
    }
  }
  // Terminal events arrive before the workflow snapshot settles. Do not keep a
  // tool or approval active during that interval, even with trailing metadata.
  if (terminal) return terminal;
  if (execution.cancelRequested) return { kind: "stopping", label: "Stopping" };
  if (execution.pendingApprovals.length) return { kind: "waiting_approval", label: "Waiting for approval" };
  if (execution.pendingQuestions?.length) return { kind: "waiting_input", label: "Waiting for your input" };
  if (tools.size) {
    const name = [...tools.values()].at(-1)!.replace(/\s+/g, " ").trim().slice(0, 80) || "tool";
    return { kind: "tool", label: `Running ${name}${tools.size > 1 ? ` · ${tools.size} tools` : ""}`, activeToolCount: tools.size };
  }
  if (execution.run.status === "queued") return { kind: "queued", label: "Waiting" };
  return responding ? { kind: "responding", label: "Writing response" } : { kind: "working", label: "Working" };
}

/** Lifecycle labels remain conservative for uncertain recovery outcomes. */
function terminalActivity(status: RunStatus): WorkerActivity | undefined {
  switch (status) {
    case "completed": return { kind: "finished", label: "Completed" };
    case "failed": return { kind: "finished", label: "Needs attention" };
    case "interrupted": return { kind: "finished", label: "Interrupted" };
    case "unknown": return { kind: "unavailable", label: "Outcome unknown" };
    default: return undefined;
  }
}
