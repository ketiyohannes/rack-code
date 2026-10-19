import assert from "node:assert/strict";
import test from "node:test";
import { TranscriptCache } from "./render-cache.js";
import { foldEvents } from "./transcript.js";
import type { RuntimeEvent } from "../../contracts/desktop/index.js";

test("incremental folds match full history and restart for replaced snapshots", () => {
  const cache = new TranscriptCache();
  const events: RuntimeEvent[] = [
    { type: "message_delta", text: "Hello " }, { type: "thinking_delta", text: "Inspect", traceId: "t" },
    { type: "tool_request", tool: "shell", toolCallId: "tool", input: { command: "pwd" } },
    { type: "message_delta", text: "world" },
  ];
  for (let length = 0; length <= events.length; length++) assert.deepEqual(cache.fold("run", events.slice(0, length)), foldEvents(events.slice(0, length)));
  const snapshot = structuredClone(events);
  snapshot[0] = { type: "message_delta", text: "Replaced " };
  assert.deepEqual(cache.fold("run", snapshot), foldEvents(snapshot));
  assert.deepEqual(cache.fold("run", events.slice(0, 1)), foldEvents(events.slice(0, 1)));
});
