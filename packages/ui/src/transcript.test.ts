import assert from "node:assert/strict";
import test from "node:test";

import { applyEvent, EMPTY_TRANSCRIPT, foldEvents } from "./transcript.js";

test("adjacent message deltas are coalesced; tools break the run of text", () => {
  const state = foldEvents([
    { type: "message_delta", text: "Hel" },
    { type: "message_delta", text: "lo" },
    { type: "tool_request", tool: "read", input: { path: "a" } },
    { type: "message_delta", text: "done" },
  ]);
  assert.deepEqual(state.items.map((item) => item.kind), ["text", "tool", "text"]);
  assert.equal(state.items[0]?.kind === "text" && state.items[0].text, "Hello");
});

test("pending questions stay in the composer and resolved answers have readable durable transcript entries", () => {
  const pending = applyEvent(EMPTY_TRANSCRIPT, { type: "question_request", request: { id: "request", questions: [
    { id: "q", question: "Which format?", options: [], allowCustom: true, multiSelect: false },
  ] } });
  assert.equal(pending.items.length, 0);
  const answered = applyEvent(pending, { type: "question_resolved", requestId: "request", response: { answers: { q: ["Short"] } } });
  assert.deepEqual(answered.items, [{ kind: "status", label: "Questions answered", detail: "Which format?\nShort" }]);
  assert.deepEqual(answered.questions, {});
});

test("thinking deltas are folded into a separate trace and approvals stay out of chat", () => {
  const state = foldEvents([
    { type: "thinking_delta", text: "check " },
    { type: "thinking_delta", text: "the file" },
    { type: "approval_request", request: { id: "approval-1", tool: "shell", input: {} } },
    { type: "message_delta", text: "Ready" },
  ]);
  assert.deepEqual(state.items.map((item) => item.kind), ["thinking", "text"]);
  assert.equal(state.items[0]?.kind === "thinking" && state.items[0].text, "check the file");
});

test("tool results pair with the latest unanswered request; unpaired results are kept", () => {
  const state = foldEvents([
    { type: "tool_result", output: "orphan" },
    { type: "tool_request", tool: "a", input: {} },
    { type: "tool_request", tool: "b", input: {} },
    { type: "tool_result", output: "for b" },
  ]);
  const [orphan, first, second] = state.items;
  assert.equal(orphan?.kind, "tool_output");
  assert.equal(first?.kind === "tool" && first.hasOutput, false);
  assert.equal(second?.kind === "tool" && second.output, "for b");
});

test("missing usage fields stay undefined rather than zero", () => {
  const state = foldEvents([
    { type: "usage", inputTokens: 10 },
    { type: "usage", costUsd: 0.01 },
  ]);
  assert.deepEqual(state.usage, { inputTokens: 10, costUsd: 0.01 });
  assert.equal(state.usage?.outputTokens, undefined);
});

test("failures keep retryability only when the adapter reported it", () => {
  assert.deepEqual(applyEvent(EMPTY_TRANSCRIPT, { type: "failed", error: "x" }).failure, { error: "x" });
  assert.deepEqual(
    applyEvent(EMPTY_TRANSCRIPT, { type: "failed", error: "x", retryable: false }).failure,
    { error: "x", retryable: false },
  );
});

test("native session IDs are recorded as diagnostics, not transcript items", () => {
  const state = foldEvents([{ type: "native_session", nativeSessionId: "n-1" }]);
  assert.equal(state.items.length, 0);
  assert.equal(state.nativeSessionId, "n-1");
});

test("parallel tools use call IDs and output deltas do not finish a call", () => {
  const streaming = foldEvents([
    { type: "tool_request", tool: "shell", input: { command: "first" }, toolCallId: "a" },
    { type: "tool_request", tool: "shell", input: { command: "second" }, toolCallId: "b" },
    { type: "tool_output_delta", toolCallId: "a", text: "part 1 " },
    { type: "tool_output_delta", toolCallId: "a", text: "part 2" },
    { type: "tool_result", toolCallId: "b", output: "second result" },
  ]);
  const first = streaming.items[0];
  assert.ok(first?.kind === "tool");
  assert.equal(first.output, "part 1 part 2");
  assert.equal(first.finished, false);
  const completed = applyEvent(streaming, { type: "tool_result", toolCallId: "a", output: "full output", isError: true });
  const result = completed.items[0];
  assert.ok(result?.kind === "tool");
  assert.equal(result.output, "full output");
  assert.equal(result.finished, true);
  assert.equal(result.isError, true);
  assert.equal(completed.items[1]?.kind === "tool" && completed.items[1].output, "second result");
});

test("updating a tool's arguments preserves its streamed output and unknown IDs stay unpaired", () => {
  const state = foldEvents([
    { type: "tool_request", tool: "read", input: {}, toolCallId: "one" },
    { type: "tool_output_delta", text: "partial", toolCallId: "one" },
    { type: "tool_request", tool: "read", input: { path: "file.ts" }, toolCallId: "one" },
    { type: "tool_result", output: "unrelated", toolCallId: "unknown" },
    { type: "tool_result", output: "legacy unknown" },
  ]);
  assert.equal(state.items.length, 3);
  assert.equal(state.items[0]?.kind === "tool" && state.items[0].output, "partial");
  assert.equal(state.items[0]?.kind === "tool" && state.items[0].finished, false);
  assert.equal(state.items[1]?.kind, "tool_output");
  assert.equal(state.items[2]?.kind, "tool_output");
});

test("thinking summaries and traces keep distinct identities when streams interleave", () => {
  const state = foldEvents([
    { type: "thinking_delta", text: "Summary", format: "summary", traceId: "summary" },
    { type: "thinking_delta", text: "Trace ", format: "trace", traceId: "trace" },
    { type: "tool_request", tool: "read", input: {} },
    { type: "thinking_delta", text: "continues", format: "trace", traceId: "trace" },
  ]);
  assert.equal(state.items.length, 3);
  assert.equal(state.items[1]?.kind === "thinking" && state.items[1].text, "Trace continues");
  assert.equal(state.items[0]?.kind === "thinking" && state.items[0].format, "summary");
});

test("routine account availability stays out of the reply; problems remain visible", () => {
  const state = foldEvents([
    { type: "availability", status: "available" },
    { type: "message_delta", text: "done" },
    { type: "availability", status: "reauth_required", reason: "Token expired" },
  ]);
  assert.deepEqual(state.items.map((item) => item.kind === "status" ? item.label : item.kind), ["text", "account reauth required"]);
});
