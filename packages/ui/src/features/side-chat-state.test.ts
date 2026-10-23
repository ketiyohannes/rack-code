/** History-driven docking must not leak visibility across PRs or override user choices. */
import assert from "node:assert/strict";
import test from "node:test";
import type { HostClient } from "@rack/client/host-client";
import { createSideChatVisibility } from "./side-chat-state.js";

test("PR chats reopen only with saved messages, respect closing, and ignore stale history", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => JSON.stringify({ "pr:a#1": "chat-a", "pr:b#1": "chat-b", "pr:empty#1": "empty", "pr:deleted#1": "deleted" }),
  } });
  try {
    const pending = new Map<string, (value: { messages: unknown[] }) => void>();
    const calls: string[] = [];
    const host = { call: async (command: string, params: { sessionId: string }) => {
      assert.equal(command, "sessions.get"); calls.push(params.sessionId);
      if (params.sessionId === "deleted") throw new Error("removed");
      return new Promise(resolve => { pending.set(params.sessionId, resolve); });
    } } as unknown as HostClient;
    let open = false;
    const visibility = createSideChatVisibility(host, value => { open = value; });
    const settle = async (id: string, messages: unknown[]) => {
      pending.get(id)!({ messages });
      await new Promise(resolve => setImmediate(resolve));
    };
    visibility.select("pr:a#1");
    await settle("chat-a", [{ role: "user", content: "Explain" }]);
    assert.equal(open, true);
    visibility.set(false);
    visibility.select("pr:a#1");
    assert.equal(open, false, "refresh does not undo a manual close");
    assert.equal(calls.length, 1);
    visibility.select(undefined);
    visibility.select("pr:a#1");
    await settle("chat-a", [{}]);
    assert.equal(open, true, "revisiting restores history again");
    visibility.select("pr:b#1");
    visibility.select("pr:new#1");
    await settle("chat-b", [{}]);
    assert.equal(open, false, "another PR's late history cannot open this panel");
    visibility.select("pr:empty#1");
    await settle("empty", []);
    assert.equal(open, false);
    visibility.select("pr:deleted#1");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(open, false);
    visibility.select("pr:a#1");
    visibility.set(false);
    await settle("chat-a", [{}]);
    assert.equal(open, false, "a manual choice wins over a pending history read");
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
