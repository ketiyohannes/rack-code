/** Worker detail data shared by supervision surfaces. Uses the same normalized
 * event folding and tool presentation as the transcript; no provider parsing. */
import type { JournalEntryView, RuntimeEvent } from "@rack/contracts";
import type { WorkflowWorker } from "@rack/features/orchestration/types";
import type { WorkerExecutionActivity } from "@rack/features/orchestration/activity";
import { projectWorkerActivity } from "@rack/features/orchestration/activity";
import { eventsFromJournal, foldEvents } from "../transcript.js";
import { presentTool } from "./tool-presentation.js";

/** Compact rows expose the current command/path without including response or
 * reasoning text. Activity precedence remains owned by projectWorkerActivity. */
export function workerSummary(worker: WorkflowWorker, live?: WorkerExecutionActivity) {
  const activity = projectWorkerActivity(worker, live);
  const current = activity.kind === "tool" && live ? foldEvents(live.events).items.filter((item) => item.kind === "tool" && !item.finished).at(-1) : undefined;
  const action = current?.kind === "tool" ? presentTool(current, true) : undefined;
  return {
    lifecycleStatus: worker.status,
    model: worker.model,
    activity,
    ...(action ? { action: { title: action.title, ...(action.subtitle ? { target: action.subtitle.replace(/\s+/g, " ").slice(0, 240) } : {}) } } : {}),
  };
}

/** Stable tool keys let the view retain disclosure nodes/focus while output
 * arrives. Unknown output is retained without guessing which call produced it. */
export function workerDetail(worker: WorkflowWorker, events: readonly RuntimeEvent[], live?: WorkerExecutionActivity) {
  const transcript = foldEvents(events);
  const active = worker.status === "running" || worker.status === "queued";
  return {
    worker,
    activity: projectWorkerActivity(worker, live),
    response: worker.result ?? transcript.items.filter((item) => item.kind === "text").map((item) => item.text).join(""),
    tools: transcript.items.flatMap((item, index) => item.kind === "tool" ? [{
      key: `${worker.id}:${item.toolCallId ?? index}`,
      presentation: presentTool(item, active),
    }] : item.kind === "tool_output" ? [{
      key: `${worker.id}:output:${index}`,
      presentation: presentTool({ kind: "tool", tool: "Tool output", input: {}, output: item.output, hasOutput: true, finished: true }, false),
    }] : []),
  };
}

export type WorkerJournalState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly events: readonly RuntimeEvent[] }
  | { readonly status: "error"; readonly message: string };

/** Bounded, lazy retained-journal cache. Active executions are read directly
 * from the live store; only settled executions should be cached. Selection
 * epochs prevent a slow previous response from replacing the new worker. */
export class WorkerJournalReader {
  private readonly cache = new Map<string, readonly RuntimeEvent[]>();
  private readonly pending = new Map<string, Promise<readonly RuntimeEvent[]>>();
  private epoch = 0;
  constructor(private readonly read: (runId: string) => Promise<readonly JournalEntryView[]>) {}

  clearSelection(): void { this.epoch++; }

  async select(runId: string, publish: (state: WorkerJournalState) => void): Promise<void> {
    const epoch = ++this.epoch;
    const cached = this.cache.get(runId);
    if (cached) { publish({ status: "ready", events: cached }); return; }
    publish({ status: "loading" });
    try {
      let request = this.pending.get(runId);
      if (!request) {
        request = this.read(runId).then((entries) => {
          const events = eventsFromJournal(entries);
          this.cache.set(runId, events);
          while (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!);
          return events;
        });
        this.pending.set(runId, request);
        // Attach both handlers so rejection does not create an unhandled
        // promise while multiple selections await the same journal.
        void request.then(() => this.pending.delete(runId), () => this.pending.delete(runId));
      }
      const events = await request;
      if (epoch === this.epoch) publish({ status: "ready", events });
    } catch (error) {
      if (epoch === this.epoch) publish({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }
}
