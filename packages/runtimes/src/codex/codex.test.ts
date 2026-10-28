import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeModelInput } from "@rack/core/execution/types";
import { CodexRuntimeAdapter } from "./codex.js";
import type { UserQuestionResponse } from "@rack/core/execution/types";

test("Codex applies native permission policy and reviewer on new/resumed threads and turns", async () => {
  for (const [mode, sandbox, approvalPolicy, approvalsReviewer] of [
    ["ask", "workspace-write", "on-request", "user"],
    ["approve_for_me", "workspace-write", "on-request", "auto_review"],
    ["full_access", "danger-full-access", "never", "user"],
    ["read_only", "read-only", "never", "user"],
  ] as const) {
    for (const resume of [false, true]) {
      const requests: { method: string; params: any }[] = [];
      const adapter = new CodexRuntimeAdapter({ resolve: async () => ({ environment: {} }) },
        { resolve: async () => ({ directory: "/context" }) }, { createProcess: () => ({
          request: async (method, params) => {
            requests.push({ method, params });
            return method.startsWith("thread/") ? { thread: { id: "thread" } } : method === "turn/start" ? { turn: { id: "turn" } } : {};
          }, notify: () => {}, respond: () => {}, respondError: () => {}, close: async () => {},
          nextMessage: async () => ({ done: false, value: { method: "turn/completed", params: { turn: { status: "completed" } } } }),
        }) });
      const input: import("@rack/core/execution/types").RuntimeRunInput = {
        runId: "run", attemptId: "attempt", sessionId: "session", projectPath: "/project", prompt: "test", permissionMode: mode,
        account: { accountId: "account", providerId: "codex", credential: { id: "credential", providerId: "codex", method: "native_login" }, runtimeContextId: "context" },
        signal: new AbortController().signal, requestApproval: async () => { throw new Error("Unexpected Rack prompt"); },
        ...(resume ? { continuation: { nativeSessionId: "thread" } } : {}),
      };
      const events = [];
      for await (const event of resume ? adapter.resumeRun(input) : adapter.startRun(input)) events.push(event);
      assert.equal(events.at(-1)?.type, "completed");
      const thread = requests.find((request) => request.method === (resume ? "thread/resume" : "thread/start"))!;
      assert.equal(thread.params.sandbox, sandbox);
      assert.equal(thread.params.approvalPolicy, approvalPolicy);
      assert.equal(thread.params.approvalsReviewer, approvalsReviewer);
      const turn = requests.find((request) => request.method === "turn/start")!;
      assert.equal(turn.params.approvalPolicy, approvalPolicy);
      assert.equal(turn.params.approvalsReviewer, approvalsReviewer);
    }
  }
});

test("Codex does not turn native automatic review into an interactive Rack approval", async () => {
  let response: unknown;
  let closed = false;
  const adapter = new CodexRuntimeAdapter({ resolve: async () => ({ environment: {} }) },
    { resolve: async () => ({ directory: "/context" }) }, { createProcess: () => ({
      request: async (method) => method === "thread/start" ? { thread: { id: "thread" } } : method === "turn/start" ? { turn: { id: "turn" } } : {},
      notify: () => {}, respond: (_id, result) => { response = result; }, respondError: () => {}, close: async () => { closed = true; },
      nextMessage: async () => ({ done: false, value: { id: "approval", method: "item/commandExecution/requestApproval", params: { command: "pwd" } } }),
    }) });
  const events = [];
  for await (const event of adapter.startRun({ runId: "run", attemptId: "attempt", sessionId: "session", projectPath: "/project", prompt: "test", permissionMode: "approve_for_me",
    account: { accountId: "account", providerId: "codex", credential: { id: "credential", providerId: "codex", method: "native_login" }, runtimeContextId: "context" },
    signal: new AbortController().signal, requestApproval: async () => { throw new Error("Unexpected Rack prompt"); } })) events.push(event);
  assert.deepEqual(response, { decision: "decline" });
  const last = events.at(-1);
  assert.equal(last?.type, "failed");
  assert.match(last?.type === "failed" ? last.error : "", /native permission settings/);
  assert.equal(closed, true);
});

test("Codex routes questions by ID and keeps reading output while an answer is pending", { timeout: 2000 }, async () => {
  let answer!: (response: UserQuestionResponse | null) => void;
  const waiting = new Promise<UserQuestionResponse | null>((resolve) => { answer = resolve; });
  let responded!: () => void;
  const responseReady = new Promise<void>((resolve) => { responded = resolve; });
  const responses: unknown[] = [];
  let message = 0;
  const adapter = new CodexRuntimeAdapter({ resolve: async () => ({ environment: {} }) }, { resolve: async () => ({ directory: "/context" }) }, { createProcess: () => ({
    request: async (method) => method.startsWith("thread/") ? { thread: { id: "thread" } } : method === "turn/start" ? { turn: { id: "turn" } } : {},
    notify: () => {}, respond: (id, result) => { responses.push({ id, result }); responded(); }, respondError: (_id, error) => { throw new Error(error); }, close: async () => {},
    nextMessage: async () => {
      if (message++ === 0) return { done: false, value: { id: "rpc-question", method: "item/tool/requestUserInput", params: {
        threadId: "thread", turnId: "turn", isBlocking: false, questions: [{ id: "language", header: "Language", question: "Which language?", isOther: true, isSecret: false,
          options: [{ label: "TypeScript", description: "Typed JavaScript" }] }],
      } } };
      if (message === 2) return { done: false, value: { method: "item/agentMessage/delta", params: { itemId: "message", delta: "Independent work" } } };
      await responseReady;
      return { done: false, value: { method: "turn/completed", params: { turn: { status: "completed" } } } };
    },
  }) });
  const iterator = adapter.startRun({ runId: "run", attemptId: "attempt", sessionId: "session", projectPath: "/project", prompt: "test", permissionMode: "approve_for_me",
    account: { accountId: "account", providerId: "codex", credential: { id: "credential", providerId: "codex", method: "native_login" }, runtimeContextId: "context" },
    signal: new AbortController().signal, requestApproval: async () => { throw new Error("Not an approval"); },
    requestQuestions: async (questions) => { assert.equal(questions[0]?.id, "language"); assert.equal(questions[0]?.allowCustom, true); return waiting; },
  })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "native_session");
  const output = (await iterator.next()).value;
  assert.equal(output?.type === "message_delta" && output.text, "Independent work");
  assert.equal(responses.length, 0);
  answer({ answers: { language: ["Rust"] } });
  assert.equal((await iterator.next()).value?.type, "completed");
  await iterator.next();
  assert.deepEqual(responses, [{ id: "rpc-question", result: { answers: { language: { answers: ["Rust"] } } } }]);
});

test("Codex native resolution cancels its pending question without sending a stale response", { timeout: 2000 }, async () => {
  let next = 0;
  let aborted = false;
  const responses: unknown[] = [];
  const messages = [
    { id: 7, method: "item/tool/requestUserInput", params: { threadId: "thread", turnId: "turn", questions: [{ id: "q", question: "Answer?", options: null, isOther: true, isSecret: true }] } },
    { method: "serverRequest/resolved", params: { threadId: "thread", requestId: 7 } },
    { method: "turn/completed", params: { turn: { status: "completed" } } },
  ];
  const adapter = new CodexRuntimeAdapter({ resolve: async () => ({ environment: {} }) }, { resolve: async () => ({ directory: "/context" }) }, { createProcess: () => ({
    request: async (method) => method.startsWith("thread/") ? { thread: { id: "thread" } } : method === "turn/start" ? { turn: { id: "turn" } } : {},
    notify: () => {}, respond: (_id, result) => { responses.push(result); }, respondError: (_id, error) => { responses.push(error); }, close: async () => {},
    nextMessage: async () => ({ done: false, value: messages[next++]! }),
  }) });
  for await (const _event of adapter.startRun({ runId: "run", attemptId: "attempt", sessionId: "session", projectPath: "/project", prompt: "test", permissionMode: "full_access",
    account: { accountId: "account", providerId: "codex", credential: { id: "c", providerId: "codex", method: "native_login" }, runtimeContextId: "ctx" },
    signal: new AbortController().signal, requestApproval: async () => "deny", requestQuestions: async (questions, signal) => {
      assert.equal(questions[0]?.isSecret, true);
      return new Promise((resolve) => signal!.addEventListener("abort", () => { aborted = true; resolve(null); }, { once: true }));
    },
  })) { /* Drain. */ }
  assert.equal(aborted, true);
  assert.deepEqual(responses, []);
});

test("Codex model discovery paginates, hides entries, and closes the process", async () => {
  const requests: string[] = [];
  const notifications: string[] = [];
  let page = 0;
  let closed = false;
  const adapter = new CodexRuntimeAdapter(
    { resolve: async () => ({ environment: {} }) },
    { resolve: async () => ({ directory: "/contexts/account-1" }) },
    {
      createProcess: () => ({
        request: async (method: string) => {
          requests.push(method);
          if (method === "initialize") return {};
          page += 1;
          return page === 1
            ? {
              data: [
                { model: "gpt-5", displayName: "GPT-5", isDefault: true },
                { model: "hidden", displayName: "Hidden", hidden: true },
              ],
              nextCursor: "page-2",
            }
            : { data: [{ model: "gpt-5", displayName: "GPT-5" }, { id: "o3", displayName: "o3" }] };
        },
        notify: (method: string) => { notifications.push(method); },
        respond: () => undefined,
        respondError: () => undefined,
        nextMessage: async () => ({ done: true, value: undefined }),
        close: async () => { closed = true; },
      }),
    },
  );

  const input: RuntimeModelInput = {
    account: {
      accountId: "account-1",
      providerId: "codex",
      credential: { id: "credential-1", providerId: "codex", method: "native_login" },
      runtimeContextId: "context-1",
    },
    projectPath: "/project/folder",
  };
  const models = await adapter.models(input);

  assert.deepEqual(models.map((model) => model.id), ["gpt-5", "o3"]);
  assert.equal(models[0]?.isDefault, true);
  assert.deepEqual(requests, ["initialize", "model/list", "model/list"]);
  assert.deepEqual(notifications, ["initialized"]);
  assert.equal(closed, true);
});

test("Codex exposes distinct trace/summary text, correlates tools, and ignores non-tool completions", async () => {
  const input: import("@rack/core/execution/types").RuntimeRunInput = {
    runId: "run", attemptId: "attempt", sessionId: "session", projectPath: "/project",
    account: { accountId: "account", providerId: "codex", credential: { id: "credential", providerId: "codex", method: "native_login" }, runtimeContextId: "context" },
    prompt: "test", permissionMode: "read_only", signal: new AbortController().signal, requestApproval: async () => "deny",
  };
  const messages = [
    { method: "item/reasoning/summaryTextDelta", params: { itemId: "reason", summaryIndex: 0, delta: "Summary" } },
    { method: "item/reasoning/textDelta", params: { itemId: "reason", contentIndex: 0, delta: "Visible trace" } },
    { method: "item/started", params: { item: { type: "commandExecution", id: "call", command: "printf done" } } },
    { method: "item/commandExecution/outputDelta", params: { itemId: "call", delta: "done" } },
    { method: "item/completed", params: { item: { type: "commandExecution", id: "call", aggregatedOutput: "done", exitCode: 0 } } },
    { method: "item/completed", params: { item: { type: "reasoning", id: "reason", summary: ["Summary"], content: ["Visible trace"] } } },
    { method: "item/agentMessage/delta", params: { itemId: "reply", delta: "Done" } },
    { method: "item/completed", params: { item: { type: "agentMessage", id: "reply", text: "Done" } } },
    { method: "turn/completed", params: { turn: { status: "completed" } } },
  ];
  const adapter = new CodexRuntimeAdapter(
    { resolve: async () => ({ environment: {} }) }, { resolve: async () => ({ directory: "/context" }) },
    { createProcess: () => ({
      request: async (method) => method === "thread/start" ? { thread: { id: "thread" } } : method === "turn/start" ? { turn: { id: "turn" } } : {},
      notify: () => {}, respond: () => {}, respondError: () => {}, close: async () => {},
      nextMessage: async () => { const value = messages.shift(); return value === undefined ? { done: true, value: undefined } : { done: false, value }; },
    }) },
  );
  const events = [];
  for await (const event of adapter.startRun(input)) events.push(event);
  assert.deepEqual(events.filter((event) => event.type === "thinking_delta").map((event) => event.type === "thinking_delta" ? [event.format, event.text] : []), [["summary", "Summary"], ["trace", "Visible trace"]]);
  const results = events.filter((event) => event.type === "tool_result");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.toolCallId, "call");
  assert.equal(events.filter((event) => event.type === "tool_output_delta").length, 1);
  assert.equal(events.filter((event) => event.type === "message_delta").map((event) => event.type === "message_delta" ? event.text : "").join(""), "Done");
});

test("Codex reports per-model reasoning efforts and forwards the chosen effort on turn/start", async () => {
  const requests: { method: string; params: any }[] = [];
  const adapter = new CodexRuntimeAdapter({ resolve: async () => ({ environment: {} }) },
    { resolve: async () => ({ directory: "/context" }) }, { createProcess: () => ({
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === "model/list") {
          return { data: [
            { model: "gpt-5", displayName: "GPT-5", defaultReasoningEffort: "medium", supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Fast" },
              { reasoningEffort: "medium", description: "Balanced" },
              { reasoningEffort: "xhigh", description: "Deepest" },
              { reasoningEffort: "low", description: "Duplicate" },
              { description: "Malformed" },
            ] },
            // A default the model does not list is not offered as a default.
            { model: "mini", displayName: "Mini", defaultReasoningEffort: "high", supportedReasoningEfforts: [] },
          ] };
        }
        return method.startsWith("thread/") ? { thread: { id: "thread" } } : method === "turn/start" ? { turn: { id: "turn" } } : {};
      }, notify: () => {}, respond: () => {}, respondError: () => {}, close: async () => {},
      nextMessage: async () => ({ done: false, value: { method: "turn/completed", params: { turn: { status: "completed" } } } }),
    }) });
  const account = { accountId: "account", providerId: "codex", credential: { id: "credential", providerId: "codex", method: "native_login" as const }, runtimeContextId: "context" };

  const models = await adapter.models({ account });
  assert.deepEqual(models[0]?.reasoningEfforts, [
    { id: "low", description: "Fast" }, { id: "medium", description: "Balanced" }, { id: "xhigh", description: "Deepest" },
  ]);
  assert.equal(models[0]?.defaultReasoningEffort, "medium");
  assert.equal(models[1]?.reasoningEfforts, undefined);
  assert.equal(models[1]?.defaultReasoningEffort, undefined);

  for (const effort of ["xhigh", undefined]) {
    requests.length = 0;
    for await (const _event of adapter.startRun({ runId: "run", attemptId: "attempt", sessionId: "session", projectPath: "/project", prompt: "test",
      permissionMode: "ask", account, signal: new AbortController().signal, requestApproval: async () => "allow",
      ...(effort === undefined ? {} : { reasoningEffort: effort }) })) { /* Drain. */ }
    const turn = requests.find((request) => request.method === "turn/start")!;
    // Omitted effort must not send a key at all, so Codex keeps the model default.
    assert.equal("effort" in turn.params, effort !== undefined);
    if (effort !== undefined) assert.equal(turn.params.effort, effort);
  }
});

test("Codex reports service tiers as speeds with a standard option and sends serviceTierForTurn", async () => {
  const requests: { method: string; params: any }[] = [];
  const adapter = new CodexRuntimeAdapter({ resolve: async () => ({ environment: {} }) },
    { resolve: async () => ({ directory: "/context" }) }, { createProcess: () => ({
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === "model/list") {
          return { data: [
            { model: "gpt-5", displayName: "GPT-5", defaultServiceTier: null, serviceTiers: [
              { id: "priority", name: "Fast", description: "Priority processing" }, { id: "priority", name: "Duplicate" }, { name: "No id" },
            ] },
            { model: "legacy", displayName: "Legacy", additionalSpeedTiers: ["fast"] },
            { model: "plain", displayName: "Plain", serviceTiers: [] },
          ] };
        }
        return method.startsWith("thread/") ? { thread: { id: "thread" } } : method === "turn/start" ? { turn: { id: "turn" } } : {};
      }, notify: () => {}, respond: () => {}, respondError: () => {}, close: async () => {},
      nextMessage: async () => ({ done: false, value: { method: "turn/completed", params: { turn: { status: "completed" } } } }),
    }) });
  const account = { accountId: "account", providerId: "codex", credential: { id: "credential", providerId: "codex", method: "native_login" as const }, runtimeContextId: "context" };
  const models = await adapter.models({ account });
  // A null default means standard speed, which stays selectable.
  assert.deepEqual(models[0]?.speeds, [
    { id: "default", label: "Standard", fast: false, description: "Codex standard speed" },
    { id: "priority", label: "Fast", fast: true, description: "Priority processing" },
  ]);
  assert.equal(models[0]?.defaultSpeed, "default");
  assert.deepEqual(models[1]?.speeds?.map((speed) => speed.id), ["default", "fast"]);
  assert.equal(models[2]?.speeds, undefined);

  for (const speed of ["priority", undefined]) {
    requests.length = 0;
    for await (const _event of adapter.startRun({ runId: "run", attemptId: "attempt", sessionId: "session", projectPath: "/project", prompt: "test",
      permissionMode: "ask", account, signal: new AbortController().signal, requestApproval: async () => "allow",
      ...(speed === undefined ? {} : { speed }) })) { /* Drain. */ }
    const turn = requests.find((request) => request.method === "turn/start")!;
    assert.equal("serviceTierForTurn" in turn.params, speed !== undefined);
    // The per-turn field is used so the thread's own tier is never rewritten.
    assert.equal("serviceTier" in turn.params, false);
    if (speed !== undefined) assert.equal(turn.params.serviceTierForTurn, speed);
  }
});

test("Codex nested usage excludes earlier resumed turns and duplicate notifications stay cumulative", async () => {
  const messages = [
    { method: "thread/tokenUsage/updated", params: { threadId: "thread", turnId: "old-turn", tokenUsage: { total: { inputTokens: 990, outputTokens: 100 }, last: { inputTokens: 900, outputTokens: 90 } } } },
    ...[20, 20, 50].map((delta) => ({ method: "thread/tokenUsage/updated", params: { threadId: "thread", turnId: "turn", tokenUsage: { total: { inputTokens: 1000 + delta, outputTokens: 100 + delta / 10 }, last: { inputTokens: delta === 50 ? 30 : 20, outputTokens: delta === 50 ? 3 : 2 } } } })),
    { method: "turn/completed", params: { turn: { status: "completed" } } },
  ];
  const adapter = new CodexRuntimeAdapter({ resolve: async () => ({ environment: {} }) }, { resolve: async () => ({ directory: "/context" }) }, { createProcess: () => ({
    request: async (method) => method.startsWith("thread/") ? { thread: { id: "thread" } } : method === "turn/start" ? { turn: { id: "turn" } } : {},
    notify: () => {}, respond: () => {}, respondError: () => {}, close: async () => {},
    nextMessage: async () => ({ done: false, value: messages.shift()! }),
  }) });
  const events = [];
  for await (const event of adapter.resumeRun({ runId: "run", attemptId: "attempt", sessionId: "session", projectPath: "/project", prompt: "test", permissionMode: "ask",
    continuation: { nativeSessionId: "thread" }, account: { accountId: "account", providerId: "codex", credential: { id: "credential", providerId: "codex", method: "native_login" }, runtimeContextId: "context" },
    signal: new AbortController().signal, requestApproval: async () => "deny" })) if (event.type === "usage") events.push(event);
  assert.deepEqual(events.map((event) => event.inputTokens), [20, 20, 50]);
  assert.deepEqual(events.map((event) => event.outputTokens), [2, 2, 5]);
});

test("Codex can forcibly close a provider stalled before thread initialization", async () => {
  let rejectStartup!: (reason: Error) => void;
  const startup = new Promise<never>((_resolve, reject) => { rejectStartup = reject; });
  let created!: () => void;
  const ready = new Promise<void>((resolve) => { created = resolve; });
  let closed = 0;
  const adapter = new CodexRuntimeAdapter({ resolve: async () => ({ environment: {} }) }, { resolve: async () => ({ directory: "/context" }) }, { createProcess: () => {
    created();
    return { request: async () => startup, notify: () => {}, respond: () => {}, respondError: () => {}, nextMessage: async () => new Promise(() => {}),
      close: async () => { closed++; rejectStartup(new Error("Provider stopped")); } };
  } });
  const controller = new AbortController();
  const iterator = adapter.startRun({ runId: "run", attemptId: "attempt", sessionId: "session", projectPath: "/project", prompt: "test", permissionMode: "ask",
    account: { accountId: "account", providerId: "codex", credential: { id: "credential", providerId: "codex", method: "native_login" }, runtimeContextId: "context" }, signal: controller.signal, requestApproval: async () => "deny" })[Symbol.asyncIterator]();
  const pending = iterator.next(); await ready;
  controller.abort(); await adapter.forceCancel({ attemptId: "attempt", signal: controller.signal });
  assert.equal((await pending).value?.type, "interrupted");
  await iterator.return?.(); assert.ok(closed > 0);
});

test("Codex sends native Plan/default collaboration modes and explicit skill input", async () => {
  const requests: { method: string; params: any }[] = [];
  const adapter = new CodexRuntimeAdapter({ resolve: async () => ({ environment: {} }) }, { resolve: async () => ({ directory: "/account" }) }, { createProcess: () => ({
    request: async (method, params) => { requests.push({ method, params }); return method.startsWith("thread/") ? { thread: { id: "thread" }, model: "native-model" } : method === "turn/start" ? { turn: { id: "turn" } } : {}; },
    notify: () => {}, respond: () => {}, respondError: () => {}, close: async () => {}, nextMessage: async () => ({ done: false, value: { method: "turn/completed", params: { turn: { status: "completed" } } } }),
  }) });
  for (const interactionMode of ["plan", "normal"] as const) {
    for await (const _ of adapter.startRun({ runId: "run", attemptId: "attempt", sessionId: "session", projectPath: "/chat", prompt: "Draft a plan", interactionMode, permissionMode: "read_only",
      skills: [{ id: "known", name: "writing", path: "/skills/writing/SKILL.md", description: "Write", source: "Personal", enabled: true }],
      account: { accountId: "account", providerId: "codex", credential: { id: "credential", providerId: "codex", method: "test" }, runtimeContextId: "account" }, signal: new AbortController().signal, requestApproval: async () => "deny" })) {}
  }
  const turns = requests.filter((request) => request.method === "turn/start");
  assert.deepEqual(turns.map((turn) => turn.params.collaborationMode.mode), ["plan", "default"]);
  assert.equal(turns[0]!.params.collaborationMode.settings.developer_instructions, null);
  assert.equal(turns[0]!.params.collaborationMode.settings.model, "native-model");
  assert.deepEqual(turns[0]!.params.input[1], { type: "skill", name: "writing", path: "/skills/writing/SKILL.md" });
  assert.ok(requests.some((request) => request.method === "skills/extraRoots/set"));
});

test("Codex skill discovery preserves disabled entries and diagnostics without a model turn", async () => {
  const methods: string[] = []; let closed = false;
  const adapter = new CodexRuntimeAdapter({ resolve: async () => ({ environment: {} }) }, { resolve: async () => ({ directory: "/account" }) }, { createProcess: () => ({
    request: async (method) => { methods.push(method); return method === "skills/list" ? { data: [{ skills: [{ name: "writing", description: "Write", path: "/skills/writing/SKILL.md", scope: "user", enabled: false }], errors: [{ message: "Malformed other skill" }] }] } : {}; },
    notify: () => {}, respond: () => {}, respondError: () => {}, close: async () => { closed = true; }, nextMessage: async () => ({ done: true, value: undefined }),
  }) });
  const catalog = await adapter.skills({ account: { accountId: "account", providerId: "codex", credential: { id: "credential", providerId: "codex", method: "test" }, runtimeContextId: "account" }, projectPath: "/project" });
  assert.equal(catalog.skills[0]!.enabled, false); assert.deepEqual(catalog.errors, ["Malformed other skill"]);
  assert.equal(closed, true); assert.ok(!methods.includes("turn/start"));
});

const codexAccount = { accountId: "account", providerId: "codex", credential: { id: "credential", providerId: "codex", method: "native_login" as const }, runtimeContextId: "context" };

test("Codex reports a new thread only after its first turn starts", async () => {
  // thread/start succeeds but turn/start fails: Codex has written no rollout,
  // so reporting the ID would save a thread that can never be resumed.
  const adapter = new CodexRuntimeAdapter({ resolve: async () => ({ environment: {} }) }, { resolve: async () => ({ directory: "/context" }) }, { createProcess: () => ({
    request: async (method) => { if (method === "turn/start") throw new Error("model unavailable"); return method === "thread/start" ? { thread: { id: "thread" } } : {}; },
    notify: () => {}, respond: () => {}, respondError: () => {}, close: async () => {},
    nextMessage: async () => ({ done: true, value: undefined }),
  }) });
  const events = [];
  for await (const event of adapter.startRun({ runId: "run", attemptId: "attempt", sessionId: "session", projectPath: "/project", prompt: "test", permissionMode: "full_access",
    account: codexAccount, signal: new AbortController().signal, requestApproval: async () => "deny" })) events.push(event);
  assert.equal(events.some((event) => event.type === "native_session"), false);
  assert.deepEqual(events.map((event) => event.type), ["failed"]);
});

test("Codex marks a resume of a thread without a rollout as an unavailable continuation", async () => {
  const requests: string[] = [];
  const adapter = new CodexRuntimeAdapter({ resolve: async () => ({ environment: {} }) }, { resolve: async () => ({ directory: "/context" }) }, { createProcess: () => ({
    request: async (method) => { requests.push(method); if (method === "thread/resume") throw new Error("no rollout found for thread id stale"); return {}; },
    notify: () => {}, respond: () => {}, respondError: () => {}, close: async () => {},
    nextMessage: async () => ({ done: true, value: undefined }),
  }) });
  const events = [];
  for await (const event of adapter.resumeRun({ runId: "run", attemptId: "attempt", sessionId: "session", projectPath: "/project", prompt: "test", permissionMode: "full_access",
    account: codexAccount, continuation: { nativeSessionId: "stale" }, signal: new AbortController().signal, requestApproval: async () => "deny" })) events.push(event);
  assert.deepEqual(events, [{ type: "failed", error: "no rollout found for thread id stale", reason: "continuation_unavailable" }]);
  assert.equal(requests.includes("turn/start"), false);
});

test("Codex ties approvals to their item and exposes MCP tool identity", async () => {
  const requests: unknown[] = [];
  const responses: unknown[] = [];
  const messages = [
    { method: "item/started", params: { item: { type: "mcpToolCall", id: "mcp", server: "github", tool: "search_issues", arguments: { query: "repo:arc-ui/web" }, status: "inProgress" } } },
    { method: "item/completed", params: { item: { type: "mcpToolCall", id: "mcp", server: "github", tool: "search_issues", status: "completed", result: { content: [] }, durationMs: 1200 } } },
    { method: "item/started", params: { item: { type: "commandExecution", id: "cmd", command: "rm -rf build" } } },
    { id: "rpc-approval", method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: "turn", itemId: "cmd", command: "rm -rf build", reason: "Deletes build output" } },
    { id: "rpc-permissions", method: "item/permissions/requestApproval", params: { threadId: "thread", turnId: "turn", permissions: { network: true } } },
    { method: "item/completed", params: { item: { type: "commandExecution", id: "cmd", status: "completed", exitCode: 0 } } },
    { method: "turn/completed", params: { turn: { status: "completed" } } },
  ];
  const adapter = new CodexRuntimeAdapter(
    { resolve: async () => ({ environment: {} }) }, { resolve: async () => ({ directory: "/context" }) },
    { createProcess: () => ({
      request: async (method) => method === "thread/start" ? { thread: { id: "thread" } } : method === "turn/start" ? { turn: { id: "turn" } } : {},
      notify: () => {}, respond: (_id, result) => { responses.push(result); }, respondError: () => {}, close: async () => {},
      nextMessage: async () => { const value = messages.shift(); return value === undefined ? { done: true, value: undefined } : { done: false, value }; },
    }) },
  );
  const events = [];
  for await (const event of adapter.startRun({ runId: "run", attemptId: "attempt", sessionId: "session", projectPath: "/project", prompt: "test", permissionMode: "ask",
    account: { accountId: "account", providerId: "codex", credential: { id: "credential", providerId: "codex", method: "native_login" }, runtimeContextId: "context" },
    signal: new AbortController().signal, requestApproval: async (request) => { requests.push(request); return "allow"; } })) events.push(event);

  const mcp = events.find((event) => event.type === "tool_request" && event.toolCallId === "mcp");
  assert.deepEqual(mcp?.type === "tool_request" && mcp.mcp, { server: "github", tool: "search_issues", arguments: { query: "repo:arc-ui/web" } });
  const command = events.find((event) => event.type === "tool_request" && event.toolCallId === "cmd");
  assert.equal(command?.type === "tool_request" && command.mcp, undefined);
  // The command approval names its item; the permissions escalation is not tied to one.
  assert.equal((requests[0] as { toolCallId?: string }).toolCallId, "cmd");
  assert.equal((requests[0] as { reason?: string }).reason, "Deletes build output");
  assert.equal("toolCallId" in (requests[1] as object), false);
  assert.equal(responses.length, 2);
});
