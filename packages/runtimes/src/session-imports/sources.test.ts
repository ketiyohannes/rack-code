import assert from "node:assert/strict";
import test from "node:test";
import { CodexLocalSessionSource } from "./codex.js";
import { ClaudeLocalSessionSource } from "./claude.js";

const thread = { id: "native", cwd: "/tmp/project", name: "Existing Codex work", createdAt: 100, updatedAt: 200 };

test("Codex discovery pages, filters folders and active sessions, and only reads native history", async () => {
  const requests: { method: string; params: unknown }[] = [];
  let closed = 0;
  let pages = 0;
  const source = new CodexLocalSessionSource({ createProcess: () => ({
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "initialize") return {};
      if (method === "thread/list") return ++pages === 1
        ? { data: [thread, { ...thread, id: "other", cwd: "/another" }, { ...thread, id: "active", status: { type: "active" } }], nextCursor: "next" }
        : { data: [{ ...thread, id: "second" }], nextCursor: null };
      if (method === "thread/read") return { thread: { ...thread, turns: [{ items: [
        { type: "userMessage", id: "u", content: [{ type: "text", text: "Original request" }] },
        { type: "reasoning", text: "hidden" },
        { type: "commandExecution", command: "echo done", aggregatedOutput: "done" },
        { type: "agentMessage", id: "a", text: "Original reply" },
      ] }] } };
      throw new Error(`Unexpected method ${method}`);
    }, notify: () => {}, close: async () => { closed += 1; },
  }) });
  assert.deepEqual((await source.list("/tmp/project")).map((session) => session.nativeSessionId), ["native", "second"]);
  const snapshot = await source.read("/tmp/project", "native");
  assert.deepEqual(snapshot.messages.map((message) => message.role), ["user", "tool", "assistant"]);
  assert.doesNotMatch(JSON.stringify(snapshot), /hidden/);
  assert.equal(closed, 2);
  assert.deepEqual(requests.filter((request) => !["initialize", "thread/list", "thread/read"].includes(request.method)), []);
  assert.equal(snapshot.session.createdAt, "1970-01-01T00:01:40.000Z");
});

test("Codex paginated turn history is fully read and mismatched IDs are rejected", async () => {
  let page = 0;
  const source = new CodexLocalSessionSource({ createProcess: () => ({
    request: async (method) => {
      if (method === "initialize") return {};
      if (method === "thread/read") return { thread };
      return { data: [{ items: [{ type: "agentMessage", text: `reply ${++page}` }] }], nextCursor: page === 1 ? "next" : null };
    }, notify: () => {}, close: async () => {},
  }) });
  assert.deepEqual((await source.read("/tmp/project", "native")).messages.map((message) => message.content), ["reply 1", "reply 2"]);
  await assert.rejects(source.read("/tmp/project", "other"), /not in/);
});

test("Codex history processes are closed after a timeout", async () => {
  let closed = false;
  const source = new CodexLocalSessionSource({ timeoutMs: 5, createProcess: () => ({
    request: async () => new Promise(() => {}), notify: () => {}, close: async () => { closed = true; },
  }) });
  await assert.rejects(source.list("/tmp/project"), /timed out/);
  assert.equal(closed, true);
});

test("Claude history uses exact-folder SDK reads and labels uncopied media and tool results", async () => {
  const info = { sessionId: "native", cwd: "/tmp/project", summary: "Existing Claude work", lastModified: 1000 };
  const source = new ClaudeLocalSessionSource({
    listSessions: async (options) => {
      assert.deepEqual(options, { dir: "/tmp/project", includeWorktrees: false });
      return [info, { ...info, sessionId: "other", cwd: "/another" }];
    },
    getSessionInfo: async () => info,
    getSessionMessages: async () => [
      { type: "user", uuid: "u", session_id: "native", parent_tool_use_id: null, parent_agent_id: null,
        message: { content: [{ type: "text", text: "Original request" }, { type: "image" }] } },
      { type: "user", uuid: "t", session_id: "native", parent_tool_use_id: null, parent_agent_id: null,
        message: { content: [{ type: "tool_result", content: "Already executed" }] } },
      { type: "assistant", uuid: "a", session_id: "native", parent_tool_use_id: null, parent_agent_id: null,
        message: { content: [{ type: "text", text: "Original reply" }, { type: "thinking", thinking: "exposed trace" }, { type: "redacted_thinking", data: "hidden" }] } },
    ],
  });
  assert.equal((await source.list("/tmp/project")).length, 1);
  const snapshot = await source.read("/tmp/project", "native");
  assert.deepEqual(snapshot.messages.map((message) => message.role), ["user", "tool", "assistant", "system"]);
  assert.equal(snapshot.messages[3]?.presentation, "thinking");
  assert.equal(snapshot.messages[3]?.content, "exposed trace");
  assert.match(snapshot.messages[0]?.content ?? "", /media was not imported/);
  assert.doesNotMatch(JSON.stringify(snapshot), /hidden/);
  await assert.rejects(source.read("/another", "native"), /not in/);
});
