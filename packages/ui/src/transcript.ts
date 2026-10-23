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
 * - tool IDs correlate concurrent calls. ID-less legacy results fall back to
 *   positional pairing; unmatched results stay visible. Output deltas do not
 *   finalize a call, and authoritative final results replace streamed output;
 * - thinking deltas are folded into a separate trace so they never become
 *   ordinary assistant text;
 * - approval requests are intentionally omitted here. The host keeps them in
 *   `pendingApprovals` and the composer renders them above the prompt.
 * - usage fields that were not reported stay `undefined`, never zero.
 */
import type { RuntimeEvent, UserQuestionRequest } from "@rack/contracts/views";

export type TranscriptItem =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string; readonly format?: "trace" | "summary"; readonly traceId?: string }
  | { readonly kind: "tool"; readonly tool: string; readonly input: unknown; readonly output?: unknown; readonly hasOutput: boolean; readonly finished: boolean; readonly toolCallId?: string; readonly isError?: boolean }
  | { readonly kind: "tool_output"; readonly output: unknown }
  | { readonly kind: "status"; readonly label: string; readonly detail?: string };

export interface UsageSummary {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

export interface TranscriptState {
  readonly questions?: Readonly<Record<string, UserQuestionRequest>>;
  readonly items: readonly TranscriptItem[];
  readonly usage?: UsageSummary;
  readonly nativeSessionId?: string;
  /** Set by a `failed` event; `retryable` is undefined when the adapter did not say. */
  readonly failure?: { readonly error: string; readonly retryable?: boolean };
}

export const EMPTY_TRANSCRIPT: TranscriptState = { items: [] };

export function applyEvent(state: TranscriptState, event: RuntimeEvent): TranscriptState {
  switch (event.type) {
    case "question_request":
      return { ...state, questions: { ...state.questions, [event.request.id]: event.request } };
    case "question_resolved": {
      const request = state.questions?.[event.requestId];
      if (request === undefined) return state;
      const { [event.requestId]: _finished, ...questions } = state.questions ?? {};
      return { ...state, questions, items: [...state.items, { kind: "status",
        label: event.response === null ? "Questions dismissed" : "Questions answered",
        detail: request.questions.map((question) => `${question.question}\n${event.response?.answers[question.id]?.join(", ") ?? "Dismissed"}`).join("\n\n") }] };
    }
    case "message_delta": {
      const last = state.items.at(-1);
      if (last?.kind === "text") {
        return { ...state, items: [...state.items.slice(0, -1), { kind: "text", text: last.text + event.text }] };
      }
      return { ...state, items: [...state.items, { kind: "text", text: event.text }] };
    }
    case "thinking_delta": {
      const identity = { ...(event.format === undefined ? {} : { format: event.format }),
        ...(event.traceId === undefined ? {} : { traceId: event.traceId }) };
      const index = event.traceId === undefined ? state.items.length - 1 : findLastIndex(state.items,
        (item) => item.kind === "thinking" && item.traceId === event.traceId && item.format === event.format);
      const last = state.items[index];
      if (last?.kind === "thinking" && last.format === event.format && last.traceId === event.traceId) {
        const items = [...state.items];
        items[index] = { ...last, text: last.text + event.text };
        return { ...state, items };
      }
      return { ...state, items: [...state.items, { kind: "thinking", text: event.text, ...identity }] };
    }
    case "tool_request": {
      const index = event.toolCallId === undefined ? -1 : findLastIndex(state.items,
        (item) => item.kind === "tool" && item.toolCallId === event.toolCallId);
      if (index !== -1) {
        const items = [...state.items];
        const previous = items[index] as Extract<TranscriptItem, { kind: "tool" }>;
        items[index] = { ...previous, tool: event.tool, input: event.input };
        return { ...state, items };
      }
      return { ...state, items: [...state.items, { kind: "tool", tool: event.tool, input: event.input,
        hasOutput: false, finished: false, ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }) }] };
    }
    case "tool_output_delta":
    case "tool_result": {
      const index = findLastIndex(state.items, (item) => item.kind === "tool" &&
        (event.toolCallId === undefined ? !item.finished && item.toolCallId === undefined : item.toolCallId === event.toolCallId));
      if (index === -1) {
        return { ...state, items: [...state.items, { kind: "tool_output", output: event.type === "tool_result" ? event.output : event.text }] };
      }
      const items = [...state.items];
      const tool = items[index] as Extract<TranscriptItem, { kind: "tool" }>;
      items[index] = event.type === "tool_output_delta"
        ? { ...tool, output: `${typeof tool.output === "string" ? tool.output : ""}${event.text}`, hasOutput: true }
        : { ...tool, output: event.output, hasOutput: true, finished: true,
          ...(event.isError === undefined ? {} : { isError: event.isError }) };
      return { ...state, items };
    }
    case "approval_request":
      // Approval UI belongs to the composer overlay, not the conversation.
      return state;
    case "native_session":
      // Diagnostic association only; shown in run details, not the transcript.
      return { ...state, nativeSessionId: event.nativeSessionId };
    case "usage":
      return { ...state, usage: mergeUsage(state.usage, event) };
    case "availability":
      // "Available" is routine (providers report it after ordinary turns) and
      // is reflected on the Accounts page; only problems belong in the reply.
      if (event.status === "available") return state;
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

/** Rebuild persisted runtime activity without treating lifecycle journal rows as tools. */
export function eventsFromJournal(entries: readonly import("@rack/contracts/views").JournalEntryView[]): readonly RuntimeEvent[] {
  return [...entries].sort((a, b) => a.sequence - b.sequence).flatMap((entry) => {
    if (entry.type === "run_started" || entry.type === "attempt_started" || entry.type === "run_status") return [];
    const payload = entry.payload;
    return typeof payload === "object" && payload !== null && "type" in payload && payload.type === entry.type
      ? [payload as RuntimeEvent] : [];
  });
}
