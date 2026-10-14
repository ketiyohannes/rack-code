/**
 * Pure folding of normalized runtime events into displayable transcript items.
 *
 * Used for live runs (applied event by event) and for snapshots received
 * from `runs.active` after a reconnect (applied to the full list), so both
 * paths render identically. The function has no DOM dependency and is unit
 * tested headlessly.
 *
 * Display rules from the UI specification:
 * - adjacent `message_delta`s are coalesced into one text block; the journal
 *   keeps the original order for recovery, this is presentation only;
 * - a `tool_result` is paired with the most recent tool request that has no
 *   result yet. Runtime events carry no tool-call ID, so pairing is
 *   positional; an unpaired result is shown on its own rather than dropped;
 * - unknown structured input/output is kept as data for an expandable view;
 * - usage fields that were not reported stay `undefined`, never zero.
 */
import type { ApprovalRequest, RuntimeEvent } from "../../contracts/desktop/views.js";

export type TranscriptItem =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "tool"; readonly tool: string; readonly input: unknown; readonly output?: unknown; readonly hasOutput: boolean }
  | { readonly kind: "tool_output"; readonly output: unknown }
  | { readonly kind: "approval"; readonly request: ApprovalRequest }
  | { readonly kind: "status"; readonly label: string; readonly detail?: string };

export interface UsageSummary {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

export interface TranscriptState {
  readonly items: readonly TranscriptItem[];
  readonly usage?: UsageSummary;
  readonly nativeSessionId?: string;
  /** Set by a `failed` event; `retryable` is undefined when the adapter did not say. */
  readonly failure?: { readonly error: string; readonly retryable?: boolean };
}

export const EMPTY_TRANSCRIPT: TranscriptState = { items: [] };

export function applyEvent(state: TranscriptState, event: RuntimeEvent): TranscriptState {
  switch (event.type) {
    case "message_delta": {
      const last = state.items.at(-1);
      if (last?.kind === "text") {
        return { ...state, items: [...state.items.slice(0, -1), { kind: "text", text: last.text + event.text }] };
      }
      return { ...state, items: [...state.items, { kind: "text", text: event.text }] };
    }
    case "thinking_delta": {
      const last = state.items.at(-1);
      if (last?.kind === "thinking") {
        return { ...state, items: [...state.items.slice(0, -1), { kind: "thinking", text: last.text + event.text }] };
      }
      return { ...state, items: [...state.items, { kind: "thinking", text: event.text }] };
    }
    case "tool_request":
      return {
        ...state,
        items: [...state.items, { kind: "tool", tool: event.tool, input: event.input, hasOutput: false }],
      };
    case "tool_result": {
      const index = findLastIndex(state.items, (item) => item.kind === "tool" && !item.hasOutput);
      if (index === -1) {
        return { ...state, items: [...state.items, { kind: "tool_output", output: event.output }] };
      }
      const items = [...state.items];
      const tool = items[index] as Extract<TranscriptItem, { kind: "tool" }>;
      items[index] = { ...tool, output: event.output, hasOutput: true };
      return { ...state, items };
    }
    case "approval_request":
      return { ...state, items: [...state.items, { kind: "approval", request: event.request }] };
    case "native_session":
      // Diagnostic association only; shown in run details, not the transcript.
      return { ...state, nativeSessionId: event.nativeSessionId };
    case "usage":
      return { ...state, usage: mergeUsage(state.usage, event) };
    case "availability":
      return {
        ...state,
        items: [...state.items, {
          kind: "status",
          label: `account ${event.status.replace("_", " ")}`,
          ...(event.reason === undefined ? {} : { detail: event.reason }),
        }],
      };
    case "completed":
      return state;
    case "failed":
      return {
        ...state,
        failure: { error: event.error, ...(event.retryable === undefined ? {} : { retryable: event.retryable }) },
      };
    case "interrupted":
      return { ...state, items: [...state.items, { kind: "status", label: "interrupted" }] };
  }
}

export function foldEvents(events: readonly RuntimeEvent[]): TranscriptState {
  return events.reduce(applyEvent, EMPTY_TRANSCRIPT);
}

/** Later usage reports overwrite earlier ones field by field; absent fields stay absent. */
function mergeUsage(previous: UsageSummary | undefined, event: Extract<RuntimeEvent, { type: "usage" }>): UsageSummary {
  return {
    ...previous,
    ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens }),
    ...(event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens }),
    ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
  };
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index] as T)) {
      return index;
    }
  }
  return -1;
}
