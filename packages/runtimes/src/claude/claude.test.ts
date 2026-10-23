import assert from "node:assert/strict";
import test from "node:test";

import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeModelInput } from "@rack/core/execution/types";
import { ClaudeRuntimeAdapter } from "./claude.js";

test("Claude maps permission choices to native SDK modes without manual prompts in auto mode", async () => {
  for (const [mode, native] of [["ask", "default"], ["approve_for_me", "auto"], ["full_access", "bypassPermissions"], ["read_only", "plan"]] as const) {
    let options!: import("@anthropic-ai/claude-agent-sdk").Options;
    let approvals = 0;
    const adapter = new ClaudeRuntimeAdapter({ resolve: async () => ({ environment: {} }) },
      { resolve: async () => ({ directory: "/context" }) }, ((value: { options: typeof options }) => {
        options = value.options;
        return { async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", result: "done" }; }, close: () => {} };
      }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query);
    for await (const _event of adapter.resumeRun({ runId: "run", attemptId: "attempt", sessionId: "session", projectPath: "/project", prompt: "test", permissionMode: mode,
      account: { accountId: "account", providerId: "claude", credential: { id: "credential", providerId: "claude", method: "native_login" }, runtimeContextId: "context" },
      continuation: { nativeSessionId: "native" }, signal: new AbortController().signal,
      requestApproval: async () => { approvals++; return "allow"; } })) { /* Drain the normalized query. */ }
    assert.equal(options.permissionMode, native);
    assert.equal(options.resume, "native");
    assert.equal(options.allowDangerouslySkipPermissions === true, mode === "full_access");
    {
      const input = { command: "touch file.txt" };
      const result = await options.canUseTool!("Bash", input, { signal: new AbortController().signal, toolUseID: "call", requestId: "request" });
      assert.ok(result);
      assert.equal(result.behavior, mode === "ask" ? "allow" : "deny");
      assert.equal(approvals, mode === "ask" ? 1 : 0);
      if (result.behavior === "allow") assert.deepEqual(result.updatedInput, input);
    }
  }
});

test("Claude questions collect answers in every permission mode without requesting action approval", async () => {
  for (const mode of ["ask", "approve_for_me", "full_access", "read_only"] as const) {
    let options!: import("@anthropic-ai/claude-agent-sdk").Options;
    // Exercise the same SDK option builder used for a real query.
    const capturing = new ClaudeRuntimeAdapter({ resolve: async () => ({ environment: {} }) }, { resolve: async () => ({ directory: "/context" }) },
      ((value: { options: typeof options }) => { options = value.options; return { async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", result: "done" }; }, close: () => {} }; }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query);
    for await (const _event of capturing.startRun({ runId: "r", attemptId: "a", sessionId: "s", projectPath: "/project", prompt: "test", permissionMode: mode,
      account: { accountId: "account", providerId: "claude", credential: { id: "c", providerId: "claude", method: "native_login" }, runtimeContextId: "ctx" },
      signal: new AbortController().signal, requestApproval: async () => { throw new Error("Questions are not action approvals"); },
      requestQuestions: async (questions) => {
        assert.equal(questions[1]?.multiSelect, true);
        assert.equal(questions[0]?.allowCustom, true);
        return { answers: { "question-1": ["Custom format"], "question-2": ["Intro", "Summary"] } };
      } })) { /* Drain. */ }
    const input = { questions: [{ question: "Format?", header: "Format", options: [{ label: "Short", description: "Brief" }], multiSelect: false },
      { question: "Sections?", header: "Sections", options: [{ label: "Intro" }, { label: "Summary" }], multiSelect: true }] };
    const result = await options.canUseTool!("AskUserQuestion", input, { signal: new AbortController().signal, toolUseID: "tool", requestId: "request" });
    assert.deepEqual(result, { behavior: "allow", updatedInput: { ...input, answers: { "Format?": "Custom format", "Sections?": "Intro, Summary" } } });
  }
});

test("Claude delivers thinking and text before completion and deduplicates seeded blocks", { timeout: 2000 }, async () => {
  let release!: () => void;
  const finish = new Promise<void>((resolve) => { release = resolve; });
  const createQuery = (() => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "stream_event", event: { type: "message_start", message: { id: "reply" } } };
      yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "Check " } } };
      yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "files" } } };
      yield { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "Hello " } } };
      yield { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "world" } } };
      await finish;
      yield { type: "assistant", message: { id: "reply", content: [{ type: "thinking", thinking: "Check files" }, { type: "text", text: "Hello world" }] } };
      yield { type: "result", subtype: "success", result: "Hello world" };
    }, close: () => release(),
  })) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
  const adapter = new ClaudeRuntimeAdapter({ resolve: async () => ({ environment: {} }) },
    { resolve: async () => ({ directory: "/context" }) }, createQuery);
  const iterator = adapter.startRun({ runId: "run", attemptId: "attempt", sessionId: "session", projectPath: "/project",
    account: { accountId: "account", providerId: "claude", credential: { id: "credential", providerId: "claude", method: "native_login" }, runtimeContextId: "context" },
    prompt: "test", permissionMode: "ask", signal: new AbortController().signal, requestApproval: async () => "allow" })[Symbol.asyncIterator]();
  const first = [];
  try {
    for (let index = 0; index < 4; index++) first.push((await iterator.next()).value);
    assert.deepEqual(first.map((event) => [event.type, event.text]), [
      ["thinking_delta", "Check "], ["thinking_delta", "files"], ["message_delta", "Hello "], ["message_delta", "world"],
    ]);
  } finally { release(); }
  const rest = [];
  for (;;) { const event = await iterator.next(); if (event.done) break; rest.push(event.value); }
  assert.deepEqual(rest.map((event) => event.type), ["usage", "completed"]);
});

test("Claude deduplicates final content delivered one block per assistant message", async () => {
  // Claude Code repeats a streamed message as one assistant message per
  // content block, so the text streamed at index 1 arrives as content[0].
  const raw = [
    { type: "stream_event", event: { type: "message_start", message: { id: "reply" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Plan" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Resolving " } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "conflicts." } } },
    { type: "assistant", message: { id: "reply", content: [{ type: "thinking", thinking: "Plan" }] } },
    { type: "assistant", message: { id: "reply", content: [{ type: "text", text: "Resolving conflicts." }] } },
    { type: "stream_event", event: { type: "message_start", message: { id: "next" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } } },
    { type: "assistant", message: { id: "next", content: [{ type: "text", text: "Done." }] } },
    { type: "result", subtype: "success", result: "Done." },
  ];
  const createQuery = (() => ({ async *[Symbol.asyncIterator]() { yield* raw; }, close: () => {} }) as unknown as Query) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
  const adapter = new ClaudeRuntimeAdapter({ resolve: async () => ({ environment: {} }) },
    { resolve: async () => ({ directory: "/context" }) }, createQuery);
  const events = [];
  for await (const event of adapter.startRun({ runId: "run", attemptId: "attempt", sessionId: "session", projectPath: "/project",
    account: { accountId: "account", providerId: "claude", credential: { id: "credential", providerId: "claude", method: "native_login" }, runtimeContextId: "context" },
    prompt: "test", permissionMode: "ask", signal: new AbortController().signal, requestApproval: async () => "allow" })) events.push(event);
  assert.deepEqual(events.flatMap((event) => event.type === "message_delta" || event.type === "thinking_delta" ? [[event.type, event.text]] : []), [
    ["thinking_delta", "Plan"], ["message_delta", "Resolving "], ["message_delta", "conflicts."], ["message_delta", "Done."],
  ]);
});

test("Claude model discovery maps supportedModels and closes the idle query", async () => {
  let closed = false;
  const query = {
    supportedModels: async () => [
      { value: "sonnet", displayName: "Sonnet", description: "Balanced model" },
      { value: "", displayName: "", description: "" },
    ],
    close: () => { closed = true; },
  } as unknown as Query;
  const createQuery = (() => query) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
  const adapter = new ClaudeRuntimeAdapter(
    { resolve: async () => ({ environment: {} }) },
    { resolve: async () => ({ directory: "/contexts/account-1" }) },
    createQuery,
  );

  const input: RuntimeModelInput = {
    account: {
      accountId: "account-1",
      providerId: "claude",
      credential: { id: "credential-1", providerId: "claude", method: "native_login" },
      runtimeContextId: "context-1",
    },
  };
  const models = await adapter.models(input);

  assert.deepEqual(models, [{
    id: "sonnet",
    label: "Sonnet",
    description: "Balanced model",
    providerId: "claude",
  }]);
  assert.equal(closed, true);
});

test("Claude requests partial messages, emits thinking once, and preserves tool IDs", async () => {
  let partial = false;
  const raw = [
    { type: "stream_event", event: { type: "message_start", message: { id: "message" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Visible thought" } } },
    { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call", name: "Bash", input: {} } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"pwd"}' } } },
    { type: "stream_event", event: { type: "content_block_stop", index: 1 } },
    { type: "assistant", message: { id: "message", content: [{ type: "thinking", thinking: "Visible thought" }, { type: "tool_use", id: "call", name: "Bash", input: { command: "pwd" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call", content: "folder", is_error: false }] } },
    { type: "result", subtype: "success", result: "Done" },
  ];
  const createQuery = ((value: { options: { includePartialMessages?: boolean } }) => {
    partial = value.options.includePartialMessages === true;
    return { async *[Symbol.asyncIterator]() { yield* raw; }, close: () => {} } as unknown as Query;
  }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
  const adapter = new ClaudeRuntimeAdapter({ resolve: async () => ({ environment: {} }) },
    { resolve: async () => ({ directory: "/context" }) }, createQuery);
  const events = [];
  for await (const event of adapter.startRun({ runId: "run", attemptId: "attempt", sessionId: "session", projectPath: "/project",
    account: { accountId: "account", providerId: "claude", credential: { id: "credential", providerId: "claude", method: "native_login" }, runtimeContextId: "context" },
    prompt: "test", permissionMode: "read_only", signal: new AbortController().signal, requestApproval: async () => "deny" })) events.push(event);
  assert.equal(partial, true);
  assert.equal(events.filter((event) => event.type === "thinking_delta").length, 1);
  assert.equal(events.filter((event) => event.type === "tool_request").every((event) => event.toolCallId === "call"), true);
  const result = events.find((event) => event.type === "tool_result");
  assert.equal(result?.type === "tool_result" && result.toolCallId, "call");
  assert.equal(result?.type === "tool_result" && result.output, "folder");
});

test("Claude reports supported effort levels and forwards or rejects the chosen effort", async () => {
  const query = {
    supportedModels: async () => [
      { value: "opus", displayName: "Opus", description: "Deep", supportsEffort: true, supportedEffortLevels: ["low", "high", "xhigh", "max"] },
      { value: "haiku", displayName: "Haiku", description: "Fast", supportsEffort: false, supportedEffortLevels: ["low"] },
    ],
    close: () => {},
  } as unknown as Query;
  const discovery = new ClaudeRuntimeAdapter({ resolve: async () => ({ environment: {} }) },
    { resolve: async () => ({ directory: "/context" }) }, (() => query) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query);
  const account = { accountId: "account", providerId: "claude", credential: { id: "credential", providerId: "claude", method: "native_login" as const }, runtimeContextId: "context" };
  const models = await discovery.models({ account });
  assert.deepEqual(models[0]?.reasoningEfforts, [{ id: "low" }, { id: "high" }, { id: "xhigh" }, { id: "max" }]);
  // A model that says it has no effort support offers no levels.
  assert.equal(models[1]?.reasoningEfforts, undefined);

  let options: import("@anthropic-ai/claude-agent-sdk").Options | undefined;
  const adapter = new ClaudeRuntimeAdapter({ resolve: async () => ({ environment: {} }) },
    { resolve: async () => ({ directory: "/context" }) }, ((value: { options: NonNullable<typeof options> }) => {
      options = value.options;
      return { async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", result: "done" }; }, close: () => {} };
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query);
  const run = async (reasoningEffort?: string) => {
    options = undefined;
    const events = [];
    for await (const event of adapter.startRun({ runId: "run", attemptId: "attempt", sessionId: "session", projectPath: "/project", prompt: "test",
      permissionMode: "ask", account, signal: new AbortController().signal, requestApproval: async () => "allow",
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })) events.push(event);
    return events;
  };

  await run("xhigh");
  assert.equal(options?.effort, "xhigh");
  await run();
  assert.equal(options !== undefined && "effort" in options, false);
  // An unknown level fails visibly instead of running at another effort.
  const events = await run("turbo");
  assert.equal(options, undefined);
  assert.equal(events.at(-1)?.type, "failed");
  assert.match(events.at(-1)?.type === "failed" ? (events.at(-1) as { error: string }).error : "", /turbo/);
});

test("Claude offers standard and fast speeds only for fast-mode models and maps them to the fastMode setting", async () => {
  const query = {
    supportedModels: async () => [
      { value: "opus", displayName: "Opus", description: "Deep", supportsFastMode: true },
      { value: "haiku", displayName: "Haiku", description: "Fast" },
    ],
    close: () => {},
  } as unknown as Query;
  const discovery = new ClaudeRuntimeAdapter({ resolve: async () => ({ environment: {} }) },
    { resolve: async () => ({ directory: "/context" }) }, (() => query) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query);
  const account = { accountId: "account", providerId: "claude", credential: { id: "credential", providerId: "claude", method: "native_login" as const }, runtimeContextId: "context" };
  const models = await discovery.models({ account });
  assert.deepEqual(models[0]?.speeds?.map((speed) => speed.id), ["standard", "fast"]);
  assert.deepEqual(models[0]?.speeds?.map((speed) => speed.fast), [false, true]);
  assert.equal(models[0]?.defaultSpeed, "standard");
  assert.equal(models[1]?.speeds, undefined);

  let options: import("@anthropic-ai/claude-agent-sdk").Options | undefined;
  const adapter = new ClaudeRuntimeAdapter({ resolve: async () => ({ environment: {} }) },
    { resolve: async () => ({ directory: "/context" }) }, ((value: { options: NonNullable<typeof options> }) => {
      options = value.options;
      return { async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", result: "done" }; }, close: () => {} };
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query);
  const run = async (speed?: string) => {
    options = undefined;
    const events = [];
    for await (const event of adapter.startRun({ runId: "run", attemptId: "attempt", sessionId: "session", projectPath: "/project", prompt: "test",
      permissionMode: "ask", account, signal: new AbortController().signal, requestApproval: async () => "allow",
      ...(speed === undefined ? {} : { speed }) })) events.push(event);
    return events;
  };
  await run("fast");
  assert.deepEqual(options?.settings, { fastMode: true });
  await run("standard");
  assert.deepEqual(options?.settings, { fastMode: false });
  await run();
  assert.equal(options !== undefined && "settings" in options, false);
  const events = await run("ludicrous");
  assert.equal(options, undefined);
  assert.equal(events.at(-1)?.type, "failed");
});

test("Claude keeps native Plan mode read-only and cannot exit it through a tool", async () => {
  let options!: import("@anthropic-ai/claude-agent-sdk").Options;
  const adapter = new ClaudeRuntimeAdapter({ resolve: async () => ({ environment: {} }) }, { resolve: async () => ({ directory: "/account" }) }, ((value: { options: typeof options }) => {
    options = value.options;
    return { async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", result: "A plan" }; }, close: () => {} } as unknown as Query;
  }) as any);
  for await (const _ of adapter.startRun({ runId: "run", attemptId: "attempt", sessionId: "chat", projectPath: "/chat", prompt: "Plan a document", permissionMode: "read_only", interactionMode: "plan",
    account: { accountId: "account", providerId: "claude", credential: { id: "credential", providerId: "claude", method: "test" }, runtimeContextId: "account" }, signal: new AbortController().signal, requestApproval: async () => "allow" })) {}
  assert.equal(options.permissionMode, "plan");
  for (const tool of ["Write", "Bash", "ExitPlanMode"]) {
    const result = await options.canUseTool!(tool, { command: "touch file" }, { signal: new AbortController().signal, toolUseID: "tool", requestId: "request" });
    assert.equal(result?.behavior, "deny");
  }
});
