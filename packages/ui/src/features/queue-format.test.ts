import assert from "node:assert/strict";
import test from "node:test";
import { queueHeading, queuePauseText } from "./queue-format.js";

test("the queue explains every pause reason in words", () => {
  assert.equal(queuePauseText("run_failed"), "Paused because the last turn failed.");
  assert.equal(queuePauseText("run_interrupted"), "Paused because the last turn was stopped.");
  assert.equal(queuePauseText("run_unknown"), "Paused because the last turn ended without a clear result.");
  assert.equal(queuePauseText("host_restarted"), "Paused because Rack restarted.");
  assert.equal(queuePauseText("start_failed"), "Paused because the next message could not start.");
  assert.equal(queuePauseText("start_failed", "The account is gone."), "Paused: the next message could not start. The account is gone.");
});

test("the heading counts waiting messages", () => {
  const item = { id: "q", prompt: "p", settings: { providerId: "p", runtimeId: "r", permissionMode: "ask" as const }, createdAt: "", updatedAt: "" };
  assert.equal(queueHeading({ items: [item] }), "1 queued message");
  assert.equal(queueHeading({ items: [item, { ...item, id: "q2" }] }), "2 queued messages");
});
