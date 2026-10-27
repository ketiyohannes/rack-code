import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEvent } from "@rack/contracts";
import {
  applyTimedEvent,
  callDurationMs,
  EMPTY_TURN,
  foldTurnActivity,
  formatDuration,
  summarizeGroup,
  toolCallEvents,
  type TurnActivity,
} from "./turn-activity.js";
import { releaseEventLog, RELEASE_HEADER_DETAIL, RELEASE_HEADER_SEQUENCE } from "./fixtures/release-blocker.js";

/** Folds `[event, offsetMs]` pairs from a fixed start. */
function fold(steps: readonly (readonly [RuntimeEvent, number?])[]): TurnActivity {
  return steps.reduce<TurnActivity>((state, [event, at]) => applyTimedEvent(state, event, at), EMPTY_TURN);
}
const request = (id: string, tool = "shell", input: unknown = { command: "pwd" }): RuntimeEvent => ({ type: "tool_request", tool, input, toolCallId: id });
const result = (id: string, isError = false, output: unknown = "ok"): RuntimeEvent => ({ type: "tool_result", toolCallId: id, output, isError });
const text = (value: string): RuntimeEvent => ({ type: "message_delta", text: value });
const onlyGroup = (state: TurnActivity) => {
  const groups = Object.values(state.groups);
  assert.equal(groups.length, 1);
  return groups[0]!;
};

test("consecutive calls between two text blocks form one group in reply order", () => {
  const state = fold([[text("Let me look.")], [request("a")], [result("a")], [request("b")], [result("b")], [text("Done.")]]);
  assert.deepEqual(state.segments.map((segment) => segment.kind), ["item", "tools", "item"]);
  const group = onlyGroup(state);
  assert.deepEqual(group.callIds, ["a", "b"]);
  assert.equal(group.closed, true);
  assert.equal(state.transcript.items[state.segments[2]!.kind === "item" ? state.segments[2]!.index : -1]?.kind, "text");
});

test("text starts a new group; thinking and blank text do not", () => {
  const state = fold([
    [request("a")], [result("a")],
    [{ type: "thinking_delta", text: "Next, the project.", format: "summary" }],
    [text("\n")],
    [request("b")], [result("b")],
    [text("Halfway there.")],
    [request("c")], [result("c")],
  ]);
  const groups = state.segments.filter((segment) => segment.kind === "tools").map((segment) => segment.kind === "tools" ? state.groups[segment.groupId]! : undefined);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0]!.callIds, ["a", "b"]);
  assert.deepEqual(groups[0]!.entries.map((entry) => entry.kind), ["call", "thought", "call"]);
  assert.deepEqual(groups[1]!.callIds, ["c"]);
  // The blank text item is never rendered.
  assert.equal(state.segments.filter((segment) => segment.kind === "item").length, 1);
});

test("parallel calls share a group, complete in any order, and are not double counted", () => {
  const state = fold([[request("a"), 0], [request("b"), 10], [result("b"), 400], [result("a"), 1000], [{ type: "completed", result: "" }, 1100]]);
  const group = onlyGroup(state);
  assert.deepEqual(group.callIds, ["a", "b"]);
  assert.equal(state.calls.a?.status, "success");
  assert.equal(callDurationMs(state.calls.a!), 1000);
  assert.equal(callDurationMs(state.calls.b!), 390);
  const summary = summarizeGroup(group, state.calls, false);
  assert.equal(summary.durationMs, 1000);
  assert.equal(summary.text, "Used 2 tools · 1.0s");
});

test("provider durations win over observation times, and repeated reports re-time the start", () => {
  const state = fold([
    // Claude reports the call while its input streams, then again when complete.
    [{ type: "tool_request", tool: "Bash", input: {}, toolCallId: "a" }, 0],
    [{ type: "tool_request", tool: "Bash", input: { command: "npm test" }, toolCallId: "a" }, 900],
    [result("a"), 1400],
    [request("b"), 1500],
    [{ type: "tool_result", toolCallId: "b", output: { durationMs: 250, exitCode: 0 } }, 2000],
  ]);
  assert.deepEqual(state.calls.a?.input, { command: "npm test" });
  assert.equal(callDurationMs(state.calls.a!), 500);
  assert.equal(callDurationMs(state.calls.b!), 250);
});

test("approval transitions: requested, allowed, then running and completed", () => {
  let state = fold([[request("post", "mcp__slack__post_message", { channel: "release" }), 0]]);
  state = applyTimedEvent(state, { type: "approval_request", request: { id: "ap", tool: "mcp__slack__post_message", input: { channel: "release" }, toolCallId: "post" } }, 20);
  assert.equal(state.calls.post?.status, "awaiting_approval");
  assert.equal(state.calls.post?.approval?.state, "pending");
  assert.equal(summarizeGroup(onlyGroup(state), state.calls, true).text, "Waiting for approval");

  state = applyTimedEvent(state, { type: "approval_resolved", approvalId: "ap", decision: "allow" }, 5000);
  assert.equal(state.calls.post?.status, "running");
  assert.equal(state.calls.post?.approval?.state, "allowed");
  assert.equal(summarizeGroup(onlyGroup(state), state.calls, true).text, "Using 1 tool");

  state = applyTimedEvent(state, result("post"), 5600);
  assert.equal(state.calls.post?.status, "success");
  // Time spent waiting for the person is excluded.
  assert.equal(callDurationMs(state.calls.post!), 600);
});

test("a denied approval stays denied even when the provider reports the refusal as an error", () => {
  const state = fold([
    [request("rm", "Bash", { command: "rm -rf build" }), 0],
    [{ type: "approval_request", request: { id: "ap", tool: "Bash", input: { command: "rm -rf build" }, toolCallId: "rm" } }, 10],
    [{ type: "approval_resolved", approvalId: "ap", decision: "deny" }, 2000],
    [result("rm", true, "The user denied this action."), 2010],
    [text("Okay, I left the build folder alone.")],
    [{ type: "completed", result: "" }],
  ]);
  assert.equal(state.calls.rm?.status, "denied");
  assert.equal(state.calls.rm?.approval?.state, "denied");
  assert.equal(callDurationMs(state.calls.rm!), undefined);
  const summary = summarizeGroup(onlyGroup(state), state.calls, false);
  assert.equal(summary.text, "Used 1 tool · 1 denied");
});

test("an approval that arrives before its call, or without a call, still forms a row", () => {
  // Codex may ask before its `item/started` reaches the stream.
  const early = fold([
    [{ type: "approval_request", request: { id: "ap", tool: "item/commandExecution/requestApproval", input: { command: "make" }, toolCallId: "cmd" } }, 0],
    [{ type: "tool_request", tool: "commandExecution", input: { type: "commandExecution", id: "cmd", command: "make" }, toolCallId: "cmd" }, 5],
  ]);
  assert.equal(onlyGroup(early).callIds.length, 1);
  assert.equal(early.calls.cmd?.tool, "commandExecution");
  assert.equal(early.calls.cmd?.status, "awaiting_approval");

  // A permissions escalation is not tied to a call: it is its own row and finishes when answered.
  let alone = fold([[{ type: "approval_request", request: { id: "perm", tool: "item/permissions/requestApproval", input: { permissions: { network: true } } } }, 0]]);
  assert.equal(alone.calls["approval:perm"]?.approvalOnly, true);
  alone = applyTimedEvent(alone, { type: "approval_resolved", approvalId: "perm", decision: "allow" }, 100);
  assert.equal(alone.calls["approval:perm"]?.status, "success");
});

test("errors are reported per call and counted in the summary", () => {
  const state = fold([[request("a"), 0], [result("a", true, { error: { message: "rate limited" } }), 300], [request("b"), 310], [result("b"), 400], [{ type: "completed", result: "" }, 500]]);
  assert.equal(state.calls.a?.status, "error");
  const summary = summarizeGroup(onlyGroup(state), state.calls, false);
  assert.equal(summary.text, "Used 2 tools · 1 failed · 390ms");
  // The header shows failures on the right, in the problem color, instead of the time.
  assert.deepEqual([summary.title, summary.detail, summary.detailIsProblem], ["Used 2 tools", "1 failed", true]);
});

test("a turn interrupted mid-tool stops running calls and leaves pending approvals unanswered", () => {
  const state = fold([
    [request("a"), 0], [result("a"), 100],
    [request("b"), 110],
    [request("c"), 120],
    [{ type: "approval_request", request: { id: "ap", tool: "shell", input: {}, toolCallId: "c" } }, 130],
    [{ type: "interrupted" }, 900],
  ]);
  assert.equal(state.calls.b?.status, "interrupted");
  assert.equal(state.calls.c?.status, "interrupted");
  assert.equal(state.calls.c?.approval?.state, "unanswered");
  assert.equal(state.outcome?.kind, "interrupted");
  assert.equal(onlyGroup(state).closed, true);
  // Even while the host still reports the run as active, nothing is "Using"
  // any more. The stopped call counts until the stop (110-900ms); the call
  // that only waited for approval never ran and adds nothing.
  assert.equal(summarizeGroup(onlyGroup(state), state.calls, true).text, "Used 3 tools · 2 stopped · 890ms");
});

test("a completed turn that never reported a call's outcome marks it incomplete", () => {
  const state = fold([[request("a")], [{ type: "completed", result: "" }]]);
  assert.equal(state.calls.a?.status, "incomplete");
});

test("calls without provider IDs match results by position", () => {
  const state = fold([
    [{ type: "tool_request", tool: "shell", input: { command: "one" } }],
    [{ type: "tool_request", tool: "shell", input: { command: "two" } }],
    [{ type: "tool_result", output: "first" }],
    [{ type: "tool_output_delta", text: "partial" }],
    [{ type: "tool_result", output: "second" }],
    [{ type: "tool_result", output: "orphan" }],
  ]);
  const calls = onlyGroup(state).callIds.map((id) => state.calls[id]!);
  assert.deepEqual(calls.map((call) => [call.output, call.status]), [["first", "success"], ["second", "success"], ["orphan", "success"]]);
  assert.equal(calls[1]?.progress, "partial");
});

test("the projection to tool-call events assigns stable group and call IDs", () => {
  const events = toolCallEvents(EMPTY_TURN, { type: "tool_request", tool: "shell", input: {} }, 5);
  assert.deepEqual(events, [{ type: "ToolCallStarted", id: "call:0", groupId: "group:1", tool: "shell", input: {}, at: 5 }]);
});

test("the release scenario reads the same live and replayed, with the expected header sequence", () => {
  const log = releaseEventLog();
  const headers: string[] = [];
  let state = EMPTY_TURN;
  for (const { event, at } of log) {
    state = applyTimedEvent(state, event, at);
    const group = Object.values(state.groups)[0];
    if (group === undefined) continue;
    const header = summarizeGroup(group, state.calls, true).title;
    if (headers.at(-1) !== header) headers.push(header);
  }
  assert.deepEqual(headers, RELEASE_HEADER_SEQUENCE);
  const times = new Map(log.map(({ event, at }) => [event, at]));
  const replayed = foldTurnActivity(log.map(({ event }) => event), (event) => times.get(event));
  assert.deepEqual(replayed, state);
  // A remote viewer that receives the log after the fact sees the finished group.
  const final = summarizeGroup(Object.values(replayed.groups)[0]!, replayed.calls, false);
  assert.equal(final.text, "Used 4 tools · 3.0s");
  assert.deepEqual([final.title, final.detail, final.detailIsProblem], ["Used 4 tools", RELEASE_HEADER_DETAIL, false]);
  assert.deepEqual(replayed.segments.map((segment) => segment.kind), ["item", "tools", "item"]);
});

test("the release scenario with a denied post", () => {
  const state = foldTurnActivity(releaseEventLog({ decision: "deny" }).map(({ event }) => event));
  assert.equal(state.calls["call-post"]?.status, "denied");
  const summary = summarizeGroup(Object.values(state.groups)[0]!, state.calls, false);
  assert.equal(summary.denied, 1);
  assert.equal(summary.total, 4);
});

test("durations format compactly", () => {
  assert.deepEqual([formatDuration(420), formatDuration(760), formatDuration(1200), formatDuration(3000), formatDuration(65_000)], ["420ms", "760ms", "1.2s", "3.0s", "1m 05s"]);
});
