import assert from "node:assert/strict";
import test from "node:test";
import { foldEvents } from "../transcript.js";
import { groupConsecutiveActivity } from "./tool-groups.js";

test("consecutive tools, outputs and thinking compact into one group; text and status break it", () => {
  const folded = foldEvents([
    { type: "thinking_delta", text: "Plan", traceId: "t1" },
    { type: "tool_request", tool: "read", input: { path: "a" }, toolCallId: "a" },
    { type: "thinking_delta", text: "Reconsider", traceId: "t2" },
    { type: "tool_request", tool: "shell", input: { command: "test" }, toolCallId: "b" },
    { type: "tool_result", output: "failed", toolCallId: "b", isError: true },
    { type: "message_delta", text: "Explanation" },
    { type: "tool_result", output: "Unpaired output", toolCallId: "unknown" },
    { type: "tool_request", tool: "read", input: {} },
    { type: "interrupted" },
  ]);
  const groups = groupConsecutiveActivity(folded.items);
  assert.deepEqual(groups.map((group) => [group.kind, group.index]), [["activity", 0], ["item", 4], ["activity", 5], ["item", 7]]);
  assert.deepEqual(groups[0]?.kind === "activity" && groups[0].items.map((item) => item.kind), ["thinking", "tool", "thinking", "tool"]);
  assert.equal(groups[0]?.kind === "activity" && groups[0].items[3]?.kind === "tool" && groups[0].items[3].isError, true);
  // Grouping preserves the original items and order, including result payloads.
  assert.deepEqual(groups.flatMap((group) => group.kind === "item" ? [group.item] : group.items), folded.items);
});

test("thinking-only runs and lone tool calls stay standalone", () => {
  const folded = foldEvents([
    { type: "thinking_delta", text: "Summary", format: "summary", traceId: "s" },
    { type: "thinking_delta", text: "Trace", format: "trace", traceId: "t" },
    { type: "message_delta", text: "Answer" },
    { type: "tool_request", tool: "read", input: {}, toolCallId: "a" },
    { type: "message_delta", text: "Done" },
  ]);
  const groups = groupConsecutiveActivity(folded.items);
  assert.deepEqual(groups.map((group) => [group.kind, group.index]), [["item", 0], ["item", 1], ["item", 2], ["item", 3], ["item", 4]]);
});

test("a growing activity sequence keeps its start index as thinking and results arrive", () => {
  const initial = [
    { type: "message_delta" as const, text: "Start" },
    { type: "tool_request" as const, tool: "read", input: {}, toolCallId: "a" },
    { type: "tool_request" as const, tool: "shell", input: {}, toolCallId: "b" },
  ];
  const first = groupConsecutiveActivity(foldEvents(initial).items).at(-1);
  const next = groupConsecutiveActivity(foldEvents([...initial,
    { type: "tool_result", output: "done", toolCallId: "a" },
    { type: "thinking_delta", text: "Next step", traceId: "t" },
    { type: "tool_request", tool: "read", input: {}, toolCallId: "c" },
  ]).items).at(-1);
  assert.equal(first?.index, next?.index);
  assert.equal(first?.kind === "activity" && first.items.length, 2);
  assert.equal(next?.kind === "activity" && next.items.length, 4);
  assert.equal(next?.kind === "activity" && next.items[0]?.kind === "tool" && next.items[0].finished, true);
  assert.deepEqual(groupConsecutiveActivity([]), []);
});
