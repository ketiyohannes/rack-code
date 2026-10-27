/**
 * Pure model of one turn's reply: text, thinking, status notes and grouped
 * tool calls with their lifecycle, timing and approvals.
 *
 * Two stages, both pure and DOM-free:
 *
 * 1. `toolCallEvents` maps one normalized `RuntimeEvent` (already
 *    backend-agnostic: the Claude and Codex runtime adapters produce it) to
 *    zero or more `ToolCallEvent`s, the tool-call lifecycle this view needs:
 *    started, updated, approval requested/resolved, completed, group closed,
 *    turn ended. It also assigns each call to a group.
 * 2. `applyToolCallEvent` folds those into `TurnActivity` state.
 *
 * `applyTimedEvent` runs both stages for one runtime event and also keeps the
 * generic transcript fold (`transcript.ts`) for text, thinking and status
 * items, so text rules live in one place. Live streams, `runs.active`
 * snapshots and replayed journals all go through the same function, which is
 * what makes a remote or reloaded view identical to the live one.
 *
 * Grouping rule: consecutive tool calls between two assistant text blocks
 * form one group. Thinking does not end a group (it is shown inside it);
 * non-blank assistant text, a status note or the end of the turn does.
 * Parallel calls therefore share a group, and an approval is a state of the
 * call it gates, not a separate block.
 *
 * Labels, icons and summaries are not part of this state. They are derived
 * at render time by `tool-formatters.ts`, so improving a formatter also
 * improves how old journals read.
 */
import type { ApprovalRequest, McpToolIdentity, RuntimeEvent } from "@rack/contracts/views";

type ApprovalDecision = "allow" | "deny";
import { applyEvent, EMPTY_TRANSCRIPT, type TranscriptState } from "../transcript.js";

// ---------------------------------------------------------------------------
// Backend-agnostic tool-call lifecycle events
// ---------------------------------------------------------------------------

/** `at` is the host observation time in epoch milliseconds, when known. */
export type ToolCallEvent =
  | {
    readonly type: "ToolCallStarted";
    readonly id: string;
    readonly groupId: string;
    readonly tool: string;
    readonly input: unknown;
    readonly mcp?: McpToolIdentity;
    readonly at?: number;
  }
  | { readonly type: "ToolCallUpdated"; readonly id: string; readonly progress: string; readonly at?: number }
  | {
    readonly type: "ToolCallApprovalRequested";
    readonly id: string;
    readonly groupId: string;
    readonly approval: ApprovalRequest;
    readonly at?: number;
  }
  | {
    readonly type: "ToolCallApprovalResolved";
    readonly id: string;
    readonly approvalId: string;
    readonly decision: ApprovalDecision;
    readonly at?: number;
  }
  | {
    readonly type: "ToolCallCompleted";
    readonly id: string;
    readonly status: "success" | "error";
    readonly output: unknown;
    /** Provider-measured duration, preferred over observation times. */
    readonly durationMs?: number;
    readonly at?: number;
  }
  | { readonly type: "ToolGroupClosed"; readonly groupId: string; readonly at?: number }
  | { readonly type: "TurnEnded"; readonly outcome: TurnOutcome; readonly at?: number };

export type TurnOutcome = "completed" | "failed" | "interrupted";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * - `running`: started, no outcome yet.
 * - `awaiting_approval`: blocked on a person.
 * - `success` / `error`: the provider reported an outcome.
 * - `denied`: a person denied the approval; any later provider result is
 *   kept as output but does not change the status.
 * - `interrupted`: the turn stopped or failed before the call finished.
 * - `incomplete`: the turn completed but never reported this call's outcome.
 */
export type ToolCallStatus = "running" | "awaiting_approval" | "success" | "error" | "denied" | "interrupted" | "incomplete";

export interface ToolCallApproval {
  readonly request: ApprovalRequest;
  /** `unanswered`: the turn ended while the approval was still pending. */
  readonly state: "pending" | "allowed" | "denied" | "unanswered";
  readonly requestedAt?: number;
  readonly resolvedAt?: number;
}

export interface ToolCall {
  readonly id: string;
  readonly groupId: string;
  readonly tool: string;
  readonly input: unknown;
  readonly mcp?: McpToolIdentity;
  readonly status: ToolCallStatus;
  /** When the call (or its latest complete input) was observed. */
  readonly startedAt?: number;
  readonly completedAt?: number;
  /** Provider-measured duration, when reported. */
  readonly durationMs?: number;
  readonly output?: unknown;
  /** Streamed output received before the final result. */
  readonly progress?: string;
  readonly approval?: ToolCallApproval;
  /**
   * True for an approval not tied to any tool call (no `toolCallId`). It is
   * shown as its own row and finishes when it is answered.
   */
  readonly approvalOnly: boolean;
}

export type ToolGroupEntry =
  | { readonly kind: "call"; readonly id: string }
  /** Index of a thinking item in `TurnActivity.transcript.items`. */
  | { readonly kind: "thought"; readonly index: number };

export interface ToolGroup {
  readonly id: string;
  /** Calls and thoughts in arrival order. */
  readonly entries: readonly ToolGroupEntry[];
  readonly callIds: readonly string[];
  /** Later text, a status note or the end of the turn closed this group. */
  readonly closed: boolean;
}

/** What the reply shows, in order: a transcript item (text, thinking, status) or a tool group. */
export type TurnSegment =
  | { readonly kind: "item"; readonly index: number }
  | { readonly kind: "tools"; readonly groupId: string };

export interface TurnActivity {
  /** Generic transcript fold; text, thinking and status segments point into its items. */
  readonly transcript: TranscriptState;
  readonly segments: readonly TurnSegment[];
  readonly groups: Readonly<Record<string, ToolGroup>>;
  readonly calls: Readonly<Record<string, ToolCall>>;
  readonly outcome?: { readonly kind: TurnOutcome; readonly at?: number };
  /** Group that new calls join; undefined after text, a status note or the end. */
  readonly openGroupId?: string;
  /** Approval ID to call ID. */
  readonly approvalCalls: Readonly<Record<string, string>>;
  /** Unfinished calls without provider IDs, oldest first, for positional result matching. */
  readonly anonymous: readonly string[];
  /** Transcript item indices already placed in `segments` or a group. */
  readonly placedItems: Readonly<Record<number, true>>;
  /** Source of synthetic group and call IDs; deterministic for a given event sequence. */
  readonly counter: number;
}

export const EMPTY_TURN: TurnActivity = {
  transcript: EMPTY_TRANSCRIPT, segments: [], groups: {}, calls: {},
  approvalCalls: {}, anonymous: [], placedItems: {}, counter: 0,
};

const TERMINAL: ReadonlySet<ToolCallStatus> = new Set(["success", "error", "denied", "interrupted", "incomplete"]);

export function isTerminal(status: ToolCallStatus): boolean {
  return TERMINAL.has(status);
}

// ---------------------------------------------------------------------------
// Stage 1: runtime event -> tool-call events
// ---------------------------------------------------------------------------

/**
 * Maps one runtime event to tool-call events. Reads `state` for correlation
 * only (open group, known IDs, anonymous calls); never changes it. Synthetic
 * IDs come from `state.counter` so a replay yields the same IDs.
 */
export function toolCallEvents(state: TurnActivity, event: RuntimeEvent, at?: number): readonly ToolCallEvent[] {
  const time = at === undefined ? {} : { at };
  let counter = state.counter;
  const nextId = (prefix: string) => `${prefix}:${counter++}`;
  const groupFor = (existing?: string) => existing ?? state.openGroupId ?? nextId("group");
  switch (event.type) {
    case "tool_request": {
      const id = event.toolCallId ?? nextId("call");
      return [{ type: "ToolCallStarted", id, groupId: groupFor(state.calls[id]?.groupId), tool: event.tool, input: event.input,
        ...(event.mcp === undefined ? {} : { mcp: event.mcp }), ...time }];
    }
    case "tool_output_delta": {
      const id = resultTarget(state, event.toolCallId);
      if (id !== undefined) return [{ type: "ToolCallUpdated", id, progress: event.text, ...time }];
      // Output nobody announced: keep it visible as its own call.
      const orphan = event.toolCallId ?? nextId("output");
      return [{ type: "ToolCallStarted", id: orphan, groupId: groupFor(), tool: "tool_output", input: undefined, ...time },
        { type: "ToolCallUpdated", id: orphan, progress: event.text, ...time }];
    }
    case "tool_result": {
      const status = event.isError === true ? "error" : "success";
      const durationMs = nativeDuration(event.output);
      const completed = (id: string): ToolCallEvent => ({ type: "ToolCallCompleted", id, status, output: event.output,
        ...(durationMs === undefined ? {} : { durationMs }), ...time });
      const id = resultTarget(state, event.toolCallId);
      if (id !== undefined) return [completed(id)];
      const orphan = event.toolCallId ?? nextId("output");
      return [{ type: "ToolCallStarted", id: orphan, groupId: groupFor(), tool: "tool_output", input: undefined, ...time }, completed(orphan)];
    }
    case "approval_request": {
      const id = event.request.toolCallId ?? `approval:${event.request.id}`;
      return [{ type: "ToolCallApprovalRequested", id, groupId: groupFor(state.calls[id]?.groupId), approval: event.request, ...time }];
    }
    case "approval_resolved": {
      const id = state.approvalCalls[event.approvalId];
      // A resolution without its request (a truncated snapshot) has nothing to update.
      return id === undefined ? [] : [{ type: "ToolCallApprovalResolved", id, approvalId: event.approvalId, decision: event.decision, ...time }];
    }
    case "completed":
      return [{ type: "TurnEnded", outcome: "completed", ...time }];
    case "failed":
      // A failure that the service recovers from (a stale native thread)
      // is journaled but does not end the turn.
      return event.reason === "continuation_unavailable" ? [] : [{ type: "TurnEnded", outcome: "failed", ...time }];
    case "interrupted":
      return [{ type: "TurnEnded", outcome: "interrupted", ...time }];
    default:
      return [];
  }
}

/** The call a result or output delta belongs to: its ID, or the oldest unfinished anonymous call. */
function resultTarget(state: TurnActivity, toolCallId: string | undefined): string | undefined {
  if (toolCallId !== undefined) return state.calls[toolCallId] === undefined ? undefined : toolCallId;
  return state.anonymous[0];
}

/** Codex command and MCP items report their own duration; prefer it. */
function nativeDuration(output: unknown): number | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const record = output as Record<string, unknown>;
  const value = record.durationMs ?? record.duration_ms;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Stage 2: tool-call events -> state
// ---------------------------------------------------------------------------

export function applyToolCallEvent(state: TurnActivity, event: ToolCallEvent): TurnActivity {
  switch (event.type) {
    case "ToolCallStarted": {
      const previous = state.calls[event.id];
      if (previous !== undefined) {
        // Providers may report a call more than once (Claude: while the input
        // streams, when it is complete, and in the final message). Keep the
        // newest name and input. Re-time the start only while the call is
        // plainly running, so the duration measures execution rather than the
        // model writing the input; an approval or outcome fixes the timeline.
        const retime = previous.status === "running" && previous.approval === undefined && event.at !== undefined;
        return withCall(state, { ...previous, tool: event.tool, input: event.input, approvalOnly: false,
          ...(event.mcp === undefined ? {} : { mcp: event.mcp }),
          ...(retime || previous.startedAt === undefined ? optional("startedAt", event.at) : {}) });
      }
      const call: ToolCall = { id: event.id, groupId: event.groupId, tool: event.tool, input: event.input, status: "running",
        approvalOnly: false, ...(event.mcp === undefined ? {} : { mcp: event.mcp }), ...optional("startedAt", event.at) };
      return addCall(state, call, isAnonymous(event.id));
    }
    case "ToolCallUpdated": {
      const call = state.calls[event.id];
      if (call === undefined || isTerminal(call.status)) return state;
      return withCall(state, { ...call, progress: (call.progress ?? "") + event.progress });
    }
    case "ToolCallApprovalRequested": {
      const approval: ToolCallApproval = { request: event.approval, state: "pending", ...optional("requestedAt", event.at) };
      const approvalCalls = { ...state.approvalCalls, [event.approval.id]: event.id };
      const previous = state.calls[event.id];
      if (previous !== undefined) {
        // An approval after the outcome cannot block anything; record it only.
        const status = isTerminal(previous.status) ? previous.status : "awaiting_approval";
        return { ...withCall(state, { ...previous, approval, status }), approvalCalls };
      }
      // The approval arrived first (or is not tied to a call). Its own tool
      // name and input describe it until a matching `tool_request` arrives.
      const call: ToolCall = { id: event.id, groupId: event.groupId, tool: event.approval.tool, input: event.approval.input,
        status: "awaiting_approval", approval, approvalOnly: event.approval.toolCallId === undefined, ...optional("startedAt", event.at) };
      return { ...addCall(state, call, false), approvalCalls };
    }
    case "ToolCallApprovalResolved": {
      const call = state.calls[event.id];
      if (call?.approval === undefined || call.approval.request.id !== event.approvalId) return state;
      const approval: ToolCallApproval = { ...call.approval, state: event.decision === "allow" ? "allowed" : "denied", ...optional("resolvedAt", event.at) };
      if (event.decision === "deny") {
        return withCall(state, { ...call, approval, status: isTerminal(call.status) ? call.status : "denied", ...optional("completedAt", event.at) });
      }
      if (call.status !== "awaiting_approval") return withCall(state, { ...call, approval });
      // An approval-only row has nothing left to run once allowed.
      return withCall(state, call.approvalOnly
        ? { ...call, approval, status: "success", ...optional("completedAt", event.at) }
        : { ...call, approval, status: "running" });
    }
    case "ToolCallCompleted": {
      const call = state.calls[event.id];
      if (call === undefined) return state;
      const anonymous = state.anonymous.filter((id) => id !== event.id);
      // A denied call stays denied: providers report the refusal as an error
      // result, which is the consequence of the decision, not a tool failure.
      const status = call.status === "denied" ? "denied" : event.status;
      const completedAt = call.status === "denied" ? call.completedAt : event.at;
      return { ...withCall(state, { ...call, status, output: event.output, ...optional("completedAt", completedAt),
        ...optional("durationMs", event.durationMs) }), anonymous };
    }
    case "ToolGroupClosed":
      return closeGroup(state, event.groupId);
    case "TurnEnded": {
      const settled = state.openGroupId === undefined ? state : closeGroup(state, state.openGroupId);
      const calls: Record<string, ToolCall> = {};
      for (const call of Object.values(settled.calls)) {
        if (isTerminal(call.status)) { calls[call.id] = call; continue; }
        // Nothing reports these calls any more. A completed turn that never
        // reported an outcome is "incomplete"; otherwise the turn stopped them.
        const status: ToolCallStatus = event.outcome === "completed" ? "incomplete" : "interrupted";
        const approval = call.approval?.state === "pending" ? { ...call.approval, state: "unanswered" as const } : call.approval;
        calls[call.id] = { ...call, status, ...(approval === undefined ? {} : { approval }), ...optional("completedAt", event.at) };
      }
      return { ...settled, calls, anonymous: [], outcome: { kind: event.outcome, ...optional("at", event.at) } };
    }
  }
}

/** Synthetic IDs given to calls the provider did not identify; their results match by position. */
function isAnonymous(id: string): boolean {
  return /^(?:call|output):\d+$/.test(id);
}

function addCall(state: TurnActivity, call: ToolCall, anonymous: boolean): TurnActivity {
  const existing = state.groups[call.groupId];
  const group: ToolGroup = existing === undefined
    ? { id: call.groupId, entries: [{ kind: "call", id: call.id }], callIds: [call.id], closed: false }
    : { ...existing, entries: [...existing.entries, { kind: "call", id: call.id }], callIds: [...existing.callIds, call.id] };
  return {
    ...state,
    calls: { ...state.calls, [call.id]: call },
    groups: { ...state.groups, [group.id]: group },
    segments: existing === undefined ? [...state.segments, { kind: "tools", groupId: group.id }] : state.segments,
    // New calls only ever join the open group or start one, so the group
    // they joined is the open group from here on.
    openGroupId: group.id,
    anonymous: anonymous ? [...state.anonymous, call.id] : state.anonymous,
    counter: Math.max(state.counter, idNumber(call.id) + 1, idNumber(call.groupId) + 1),
  };
}

function withCall(state: TurnActivity, call: ToolCall): TurnActivity {
  return { ...state, calls: { ...state.calls, [call.id]: call } };
}

function closeGroup(state: TurnActivity, groupId: string): TurnActivity {
  const group = state.groups[groupId];
  const groups = group === undefined || group.closed ? state.groups : { ...state.groups, [groupId]: { ...group, closed: true } };
  const { openGroupId: _closed, ...rest } = state;
  return state.openGroupId === groupId ? { ...rest, groups } : { ...state, groups };
}

/** Numeric suffix of a synthetic ID (`group:3`), or -1 for provider IDs. */
function idNumber(id: string): number {
  const match = /^(?:group|call|output):(\d+)$/.exec(id);
  return match === null ? -1 : Number(match[1]);
}

function optional<K extends string>(key: K, value: number | undefined): { [P in K]?: number } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: number };
}

// ---------------------------------------------------------------------------
// Combined fold: transcript items + tool groups
// ---------------------------------------------------------------------------

/** Applies one runtime event observed at `at` (epoch ms, when known). */
export function applyTimedEvent(state: TurnActivity, event: RuntimeEvent, at?: number): TurnActivity {
  const before = state.transcript.items.length;
  let next: TurnActivity = { ...state, transcript: applyEvent(state.transcript, event) };
  next = placeTranscriptItems(next, before, at);
  for (const toolEvent of toolCallEvents(next, event, at)) next = applyToolCallEvent(next, toolEvent);
  return next;
}

export function foldTurnActivity(events: readonly RuntimeEvent[], timeOf: (event: RuntimeEvent) => number | undefined = () => undefined): TurnActivity {
  return events.reduce<TurnActivity>((state, event) => applyTimedEvent(state, event, timeOf(event)), EMPTY_TURN);
}

/**
 * Places new transcript items: thinking joins the open group, while
 * non-blank text and status notes close it and become their own segments.
 * Text is placed once it has visible content, so a stray newline between two
 * tool calls neither splits their group nor renders as an empty block.
 */
function placeTranscriptItems(state: TurnActivity, before: number, at: number | undefined): TurnActivity {
  const items = state.transcript.items;
  let next = state;
  // New items, plus the last one (text grows in place and may only now be non-blank).
  const candidates = new Set<number>();
  for (let index = Math.max(0, before - 1); index < items.length; index += 1) candidates.add(index);
  for (const index of candidates) {
    if (next.placedItems[index] === true) continue;
    const item = items[index]!;
    if (item.kind === "tool" || item.kind === "tool_output") continue;
    if (item.kind === "text" && item.text.trim() === "") continue;
    const placedItems = { ...next.placedItems, [index]: true as const };
    if (item.kind === "thinking" && next.openGroupId !== undefined) {
      const group = next.groups[next.openGroupId]!;
      next = { ...next, placedItems, groups: { ...next.groups, [group.id]: { ...group, entries: [...group.entries, { kind: "thought", index }] } } };
      continue;
    }
    if (next.openGroupId !== undefined && item.kind !== "thinking") next = applyToolCallEvent(next, { type: "ToolGroupClosed", groupId: next.openGroupId, ...optional("at", at) });
    next = { ...next, placedItems, segments: [...next.segments, { kind: "item", index }] };
  }
  return next;
}

// ---------------------------------------------------------------------------
// Derived values for presentation
// ---------------------------------------------------------------------------

/** Execution time of a call: provider duration, else observed interval from start (or approval) to outcome. */
export function callDurationMs(call: ToolCall): number | undefined {
  if (call.status === "denied" || call.approvalOnly) return undefined;
  if (call.durationMs !== undefined) return call.durationMs;
  const interval = callInterval(call);
  return interval === undefined ? undefined : interval[1] - interval[0];
}

/**
 * Observed execution interval; time spent waiting for a person is excluded.
 * A gated call runs only from its Allow; one never allowed never ran. A call
 * stopped by an interruption counts until the interruption.
 */
function callInterval(call: ToolCall): readonly [number, number] | undefined {
  if (call.approval !== undefined && call.approval.state !== "allowed") return undefined;
  const start = call.approval?.state === "allowed" ? call.approval.resolvedAt ?? call.startedAt : call.startedAt;
  if (start === undefined || call.completedAt === undefined || call.completedAt < start) return undefined;
  return [start, call.completedAt];
}

/**
 * Time the group spent running tools: the union of its calls' execution
 * intervals, so parallel calls are not double counted and approval waits
 * and model thinking between calls are excluded. Calls known only by a
 * provider duration add that duration.
 */
export function groupDurationMs(group: ToolGroup, calls: Readonly<Record<string, ToolCall>>): number | undefined {
  const intervals: [number, number][] = [];
  let untimed = 0;
  let measured = false;
  for (const id of group.callIds) {
    const call = calls[id];
    if (call === undefined || call.status === "denied" || call.approvalOnly) continue;
    const interval = callInterval(call);
    if (interval !== undefined && call.durationMs === undefined) { intervals.push([interval[0], interval[1]]); measured = true; continue; }
    if (call.durationMs !== undefined) {
      measured = true;
      if (interval !== undefined) intervals.push([interval[1] - call.durationMs, interval[1]]); else untimed += call.durationMs;
    }
  }
  if (!measured) return undefined;
  intervals.sort((a, b) => a[0] - b[0]);
  let total = untimed;
  let current: [number, number] | undefined;
  for (const interval of intervals) {
    if (current === undefined || interval[0] > current[1]) {
      if (current !== undefined) total += current[1] - current[0];
      current = [interval[0], interval[1]];
    } else current[1] = Math.max(current[1], interval[1]);
  }
  if (current !== undefined) total += current[1] - current[0];
  return total;
}

/**
 * Display phase of a group:
 * - `waiting`: the run is live and a call in this group needs a decision;
 * - `active`: the run is live and the group may still grow;
 * - `done`: closed by later text, by the end of the turn, or the run is no
 *   longer live (a replayed or interrupted run never shows as working).
 */
export type GroupPhase = "waiting" | "active" | "done";

export function groupPhase(group: ToolGroup, calls: Readonly<Record<string, ToolCall>>, live: boolean): GroupPhase {
  if (!live) return "done";
  if (group.callIds.some((id) => calls[id]?.approval?.state === "pending" && calls[id]?.status === "awaiting_approval")) return "waiting";
  if (!group.closed || group.callIds.some((id) => !isTerminal(calls[id]?.status ?? "success"))) return "active";
  return "done";
}

/** A call's status as displayed: unfinished calls of a run that is no longer live are incomplete. */
export function displayStatus(call: ToolCall, live: boolean): ToolCallStatus {
  return !live && !isTerminal(call.status) ? "incomplete" : call.status;
}

export interface GroupSummary {
  readonly phase: GroupPhase;
  /** Left side of the header: "Using 3 tools", "Waiting for approval", "Used 4 tools". */
  readonly title: string;
  /**
   * Right side of the header once done: problems ("1 failed", "1 denied")
   * when there are any, otherwise the group's tool time ("3.0s").
   */
  readonly detail?: string;
  /** True when `detail` reports failures, shown in the problem color. */
  readonly detailIsProblem: boolean;
  /** Title and detail as one sentence, for accessible names and logs. */
  readonly text: string;
  readonly total: number;
  readonly failed: number;
  readonly denied: number;
  readonly stopped: number;
  readonly durationMs?: number;
}

/** Header text: title "Using 3 tools" / "Waiting for approval" / "Used 4 tools", detail "3.0s" or "1 failed". */
export function summarizeGroup(group: ToolGroup, calls: Readonly<Record<string, ToolCall>>, live: boolean): GroupSummary {
  const phase = groupPhase(group, calls, live);
  const statuses = group.callIds.flatMap((id) => calls[id] === undefined ? [] : [displayStatus(calls[id]!, live)]);
  const total = statuses.length;
  const failed = statuses.filter((status) => status === "error").length;
  const denied = statuses.filter((status) => status === "denied").length;
  const stopped = statuses.filter((status) => status === "interrupted" || status === "incomplete").length;
  const durationMs = groupDurationMs(group, calls);
  const tools = `${total} ${total === 1 ? "tool" : "tools"}`;
  const title = phase === "waiting" ? "Waiting for approval" : phase === "active" ? `Using ${tools}` : `Used ${tools}`;
  const problems = [failed > 0 ? `${failed} failed` : null, denied > 0 ? `${denied} denied` : null, stopped > 0 ? `${stopped} stopped` : null]
    .filter((part): part is string => part !== null);
  // Only a finished group reports a detail; while working the header stays a single quiet line.
  const detail = phase !== "done" ? undefined
    : problems.length > 0 ? problems.join(" · ") : durationMs === undefined ? undefined : formatDuration(durationMs);
  const text = phase !== "done" ? title
    : [title, ...problems, durationMs === undefined ? null : formatDuration(durationMs)].filter((part) => part !== null).join(" · ");
  return { phase, title, ...(detail === undefined ? {} : { detail }), detailIsProblem: failed > 0, text, total, failed, denied, stopped,
    ...(durationMs === undefined ? {} : { durationMs }) };
}

/** "760ms", "1.2s", "1m 05s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
