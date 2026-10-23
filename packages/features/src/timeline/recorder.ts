/**
 * Per-run capture scheduling.
 *
 * A `RunRecorder` turns run activity into capture requests:
 *
 * | Trigger                         | Label                          |
 * | ------------------------------- | ------------------------------ |
 * | normalized `tool_request`       | `Before tool`                  |
 * | normalized `tool_result`        | `After <tool name>`            |
 * | filesystem activity (debounced) | `Live filesystem observation`  |
 * | run finalization                | `Run settled`                  |
 *
 * The run-start observation is captured by `TimelineService.beginRun` before
 * the recorder exists, so it completes before the runtime starts editing.
 *
 * Ordering and coalescing: requests run strictly one after another on a
 * promise chain, so snapshots of one session never interleave. Tool-boundary
 * requests are all kept because each carries a distinct label and tool call.
 * Watcher requests are coalesced: while one is queued but not yet started,
 * further filesystem activity is absorbed by it, because the later capture
 * will observe the newer disk state anyway.
 *
 * Observation, not proof: tool notifications are asynchronous, so an edit may
 * already be on disk when `Before tool` is captured, and files created and
 * removed between two captures never appear. Labels describe when Rack looked,
 * not who changed what.
 *
 * Failure: the first failed capture stops all further capture for this run
 * and closes the watcher. The failure is reported once through `onFailure`;
 * the run itself continues unaffected.
 */
import type { WatchHandle } from "./ports.js";

/** Captures one snapshot; rejects on failure. Supplied by `TimelineService`. */
export type CaptureRequest = (label: string, metadata: { readonly toolCallId?: string }) => Promise<void>;

/** Run activity relevant to capture, in the normalized runtime-event shape. */
export type RecorderEvent =
  | { readonly type: "tool_request"; readonly tool: string; readonly toolCallId?: string }
  | { readonly type: "tool_result"; readonly toolCallId?: string }
  | { readonly type: string };

/** Debounce applied to filesystem notifications before an observation. */
export const WATCH_DEBOUNCE_MS = 120;

const MAX_TOOL_NAME = 80;

export interface RunRecorderOptions {
  readonly capture: CaptureRequest;
  readonly onFailure: (message: string) => void;
  /** Starts the recursive watcher; returning `undefined` disables live observation. */
  readonly startWatch?: (onChange: () => void) => WatchHandle | undefined;
  readonly debounceMs?: number;
}

export class RunRecorder {
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  private finished = false;
  private watcherQueued = false;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private watch: WatchHandle | undefined;
  /** Tool names by call ID, so `tool_result` can name the tool it ends. */
  private readonly toolNames = new Map<string, string>();
  /** Fallback for runtimes that omit call IDs on results. */
  private lastToolName: string | undefined;
  private readonly debounceMs: number;

  constructor(private readonly options: RunRecorderOptions) {
    this.debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS;
    try {
      this.watch = options.startWatch?.(() => this.scheduleObservation());
    } catch {
      // Watching is an optimization; boundary capture still records the run.
      this.watch = undefined;
    }
  }

  /** Feeds one runtime event. Never throws and never blocks the caller. */
  observe(event: RecorderEvent): void {
    if (this.stopped || this.finished) return;
    if (event.type === "tool_request" && "tool" in event) {
      const name = singleLine(event.tool) || "tool";
      if (event.toolCallId !== undefined) this.toolNames.set(event.toolCallId, name);
      this.lastToolName = name;
      this.request("Before tool", event.toolCallId);
    } else if (event.type === "tool_result") {
      const callId = "toolCallId" in event ? event.toolCallId : undefined;
      const name = (callId === undefined ? undefined : this.toolNames.get(callId)) ?? this.lastToolName ?? "tool";
      this.request(`After ${name}`, callId);
    }
  }

  /**
   * Records `Run settled` (also after failure or cancellation) and resolves
   * once every queued capture has settled. Idempotent.
   */
  async finish(): Promise<void> {
    if (!this.finished) {
      this.finished = true;
      this.closeWatch();
      if (!this.stopped) this.enqueue(() => this.options.capture("Run settled", {}));
    }
    await this.chain;
  }

  /** Stops without a final capture, for runs that never started. */
  abandon(): void {
    this.finished = true;
    this.closeWatch();
  }

  private scheduleObservation(): void {
    if (this.stopped || this.finished) return;
    if (this.debounce !== undefined) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      if (this.stopped || this.finished || this.watcherQueued) return;
      this.watcherQueued = true;
      this.enqueue(async () => {
        // Clear before capturing: activity during this capture must queue
        // one more observation rather than be absorbed by this one.
        this.watcherQueued = false;
        await this.options.capture("Live filesystem observation", {});
      });
    }, this.debounceMs);
  }

  private request(label: string, toolCallId: string | undefined): void {
    this.enqueue(() => this.options.capture(label, toolCallId === undefined ? {} : { toolCallId }));
  }

  private enqueue(operation: () => Promise<void>): void {
    this.chain = this.chain.then(async () => {
      if (this.stopped) return;
      try {
        await operation();
      } catch (error) {
        this.stop(error instanceof Error ? error.message : String(error));
      }
    });
  }

  private stop(message: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.closeWatch();
    try {
      this.options.onFailure(message);
    } catch {
      // Failure reporting must not break the capture chain.
    }
  }

  private closeWatch(): void {
    if (this.debounce !== undefined) clearTimeout(this.debounce);
    this.debounce = undefined;
    this.watch?.close();
    this.watch = undefined;
  }
}

/** Tool names become part of a one-line label and a commit subject. */
function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_TOOL_NAME);
}
