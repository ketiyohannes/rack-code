import { claudeSkills, claudeSkillPlugins } from "./installed-skills.js";
import {
  query,
  type EffortLevel,
  type Options,
  type PermissionResult,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  CredentialResolver,
  RuntimeContextResolver,
} from "../../core/authentication/contracts.js";
import type {
  PermissionMode,
  RuntimeAccountContext,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeModel,
  RuntimeModelInput,
  RuntimeRunInput,
  SpeedOption,
} from "../../core/execution/types.js";
import { AsyncQueue } from "../../core/shared/async-queue.js";
import { nativeQuestions } from "./user-questions.js";
import { startAppToolServer } from "./app-tool-server.js";

/**
 * Claude Agent SDK adapter.
 *
 * The SDK is intentionally imported only here. The adapter translates SDK
 * messages, permission callbacks, account rate-limit events, and native
 * session IDs into the application-owned runtime contract.
 */
export class ClaudeRuntimeAdapter implements RuntimeAdapter {
  readonly runtimeId = "claude-agent-sdk";
  readonly providerId = "claude";
  private readonly activeQueries = new Map<string, ReturnType<typeof query>>();

  constructor(
    private readonly credentials: CredentialResolver,
    private readonly contexts: RuntimeContextResolver,
    private readonly createQuery: typeof query = query,
  ) {}

  /**
   * Initialize an idle SDK query and ask for its account-specific catalog.
   * The input queue never receives a user message, so this cannot start a
   * model turn or execute tools. Completion/timeout always closes the queue
   * and child process; discovery does not create a persisted session.
   */
  async models(input: RuntimeModelInput): Promise<readonly RuntimeModel[]> {
    const credential = await this.credentials.resolve(input.account.credential);
    const context = await this.contexts.resolve(input.account.runtimeContextId);
    const prompts = new AsyncQueue<SDKUserMessage>();
    const abortController = new AbortController();
    let discovery: ReturnType<typeof query> | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      discovery = this.createQuery({
        prompt: prompts,
        options: {
          cwd: input.projectPath ?? context.directory,
          env: {
            ...stringEnvironment(process.env, new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"])),
            ...context.environment, ...credential.environment, CLAUDE_CONFIG_DIR: context.directory,
          },
          abortController, persistSession: false, permissionMode: "plan",
        },
      });
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Claude model discovery timed out.")), 15_000);
      });
      const entries = await Promise.race([discovery.supportedModels(), timeout]);
      return entries.filter((entry) => entry.value.trim() !== "").map((entry) => {
        // Only models that declare effort support get selectable levels. The
        // SDK reports no per-model default, so the picker offers "Default"
        // (omit the option) alongside the explicit levels.
        const levels = entry.supportsEffort === false ? [] : (entry.supportedEffortLevels ?? []);
        return {
          id: entry.value, label: entry.displayName, description: entry.description, providerId: this.providerId,
          ...(levels.length > 0 ? { reasoningEfforts: levels.map((level) => ({ id: level })) } : {}),
          // Fast mode is the only speed control Claude exposes; offer it only
          // for models that report support. Whether a request is actually
          // served fast (plan, usage, cooldown) is decided by Claude.
          ...(entry.supportsFastMode === true ? { speeds: CLAUDE_SPEEDS, defaultSpeed: "standard" } : {}),
        };
      });
    } finally {
      clearTimeout(timer);
      prompts.complete();
      discovery?.close();
      abortController.abort();
    }
  }

  /** Read skill metadata without loading user auth/settings into this account. */
  async skills(input: RuntimeModelInput): Promise<import("../../core/execution/types.js").SkillCatalog> {
    const context = await this.contexts.resolve(input.account.runtimeContextId);
    return claudeSkills(input.projectPath ?? context.directory, context.directory);
  }

  async capabilities(_account: RuntimeAccountContext): Promise<RuntimeCapabilities> {
    return {
      resume: true,
      fork: false,
      approvals: true,
      quotaReporting: true,
      browserTools: false,
      computerUse: false,
    };
  }

  describePermissionMode(mode: PermissionMode): string {
    const permission = claudePermission(mode);
    if (permission.bypass) {
      return `SDK permission mode '${permission.mode}' with dangerous-skip allowed; no approval prompts.`;
    }
    if (permission.mode === "auto") {
      return "SDK permission mode 'auto'; Claude's native classifier approves or denies actions, without Rack approval prompts.";
    }
    return permission.approvals
      ? `SDK permission mode '${permission.mode}'; tool use is routed through the app approval prompt.`
      : `SDK permission mode '${permission.mode}'; the agent plans without executing tools.`;
  }

  startRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    return this.run(input);
  }

  resumeRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    return this.run(input);
  }

  async cancel(input: Pick<RuntimeRunInput, "attemptId" | "signal">): Promise<void> {
    // The SDK query is owned by the async generator. Aborting the signal is
    // the documented cancellation mechanism; this method exists so the core
    // can use one cancellation operation for every runtime.
    const active = this.activeQueries.get(input.attemptId);
    active?.close();
  }

  async forceCancel(input: Pick<RuntimeRunInput, "attemptId" | "signal">): Promise<void> {
    this.activeQueries.get(input.attemptId)?.close();
    this.activeQueries.delete(input.attemptId);
  }

  private async *run(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    if (input.interactionMode === "plan") input = { ...input, permissionMode: "read_only" };
    const credential = await this.credentials.resolve(input.account.credential);
    const context = await this.contexts.resolve(input.account.runtimeContextId);
    const environment = {
      // Do not let a parent API key silently override the selected
      // subscription account. The credential resolver supplies the chosen
      // auth variables below.
      ...stringEnvironment(process.env, new Set([
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
      ])),
      ...(context.environment === undefined ? {} : context.environment),
      ...credential.environment,
      CLAUDE_CONFIG_DIR: context.directory,
    };
    const sdkAbort = new AbortController();
    const abort = () => sdkAbort.abort();
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) {
      sdkAbort.abort();
    }

    let seenSessionId: string | undefined;
    const eventState: ClaudeEventState = { messageId: "", nextMessage: 0, streamed: new Map(), tools: new Map() };
    let activeQuery: ReturnType<typeof query> | undefined;
    let appTools: Awaited<ReturnType<typeof startAppToolServer>>;
    let skillPlugins: Awaited<ReturnType<typeof claudeSkillPlugins>> | undefined;
    try {
      const options = this.options(input, environment, sdkAbort);
      skillPlugins = await claudeSkillPlugins(input.skills ?? []);
      if (skillPlugins.plugins.length) options.plugins = skillPlugins.plugins;
      appTools = await startAppToolServer(input.tools ?? [], input.signal);
      if (appTools !== undefined) {
        options.mcpServers = { ...options.mcpServers, rack: { type: "http", url: appTools.url, headers: { Authorization: `Bearer ${appTools.token}` } } };
        // Core owns Ask mode's broker and the defensive read-only deny.
        // Automatic mode must still pass through Claude's native reviewer;
        // allow-listing it there would silently bypass that review.
        if (input.permissionMode !== "approve_for_me") {
          options.allowedTools = [...(options.allowedTools ?? []), ...(input.tools ?? []).map((tool) => `mcp__rack__${tool.name}`)];
        }
      }
      input.signal.throwIfAborted();
      // A single explicit selection is a native user slash command, which also
      // supports skills marked disable-model-invocation. Multiple selections
      // ask the native Skill tool to load each named skill in the same turn.
      const prompt = skillPlugins.names.length === 1 ? `/${skillPlugins.names[0]} ${input.prompt}`
        : skillPlugins.names.length ? `Use the native Skill tool to invoke these explicitly selected skills for this request: ${skillPlugins.names.join(", ")}.\n\n${input.prompt}` : input.prompt;
      activeQuery = this.createQuery({ prompt, options });
      this.activeQueries.set(input.attemptId, activeQuery);
      for await (const rawMessage of activeQuery) {
        const message: unknown = rawMessage;
        const sessionId = stringField(message, "session_id");
        if (sessionId !== undefined && sessionId !== seenSessionId) {
          seenSessionId = sessionId;
          yield { type: "native_session", nativeSessionId: sessionId };
        }
        yield* mapClaudeMessage(message, eventState);
        if (input.signal.aborted) {
          yield { type: "interrupted" };
          break;
        }
      }
    } catch (error) {
      if (input.signal.aborted || isAbortError(error)) {
        yield { type: "interrupted" };
      } else {
        const text = error instanceof Error ? error.message : String(error);
        yield { type: "failed", error: text };
      }
    } finally {
      input.signal.removeEventListener("abort", abort);
      // Query.close is safe after normal completion and releases the SDK
      // child process and any MCP transports held by the query.
      activeQuery?.close();
      await appTools?.close();
      await skillPlugins?.close();
      this.activeQueries.delete(input.attemptId);
    }
  }

  private options(
    input: RuntimeRunInput,
    environment: Record<string, string>,
    abortController: AbortController,
  ): Options {
    const permission = claudePermission(input.permissionMode);
    const options: Options = {
      cwd: input.projectPath,
      env: environment,
      abortController,
      permissionMode: permission.mode,
      includePartialMessages: true,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoningEffort === undefined ? {} : { effort: claudeEffort(input.reasoningEffort) }),
      // Fast mode is a flag-tier setting. "standard" sends `fastMode: false`
      // explicitly so a user-level default cannot silently turn it on.
      ...(input.speed === undefined ? {} : { settings: { fastMode: claudeFastMode(input.speed) } }),
      ...(input.continuation === undefined ? {} : { resume: input.continuation.nativeSessionId }),
      ...(permission.bypass ? { allowDangerouslySkipPermissions: true } : {}),
    };
    if (permission.approvals) {
      options.canUseTool = async (
        toolName,
        toolInput,
        callbackOptions,
      ): Promise<PermissionResult> => {
        if (callbackOptions.signal.aborted || input.signal.aborted) {
          return { behavior: "deny", message: "Execution was interrupted." };
        }
        const decision = await input.requestApproval({
          tool: toolName,
          input: toolInput,
        });
        return decision === "allow"
          ? { behavior: "allow", updatedInput: toolInput }
          : { behavior: "deny", message: "The user denied this action." };
      };
    } else if (input.permissionMode === "read_only") {
      // Plan mode forwards attempted mutations to canUseTool. Deny them at
      // that native boundary; read tools permitted by plan mode still run.
      options.canUseTool = async () => ({ behavior: "deny", message: "Read only mode does not permit this action." });
    }
    const permissionHandler = options.canUseTool;
    // Question answers are independent of action permissions. Even native
    // auto-review/bypass modes must collect the user's own answer here.
    options.canUseTool = async (toolName, toolInput, callbackOptions): Promise<PermissionResult> => {
      if (input.interactionMode === "plan" && toolName === "ExitPlanMode") return { behavior: "deny", message: "Finish the plan in your response. The user must click Implement in Rack to leave Plan mode." };
      if (toolName !== "AskUserQuestion") return permissionHandler === undefined
        ? { behavior: "deny", message: "Native permission policy did not authorize this action." }
        : (await permissionHandler(toolName, toolInput, callbackOptions)) ?? { behavior: "deny", message: "This action was not authorized." };
      if (callbackOptions.signal.aborted || input.signal.aborted || input.requestQuestions === undefined) {
        return { behavior: "deny", message: "Question input is unavailable or was interrupted." };
      }
      const questions = nativeQuestions(toolInput, "claude");
      const response = await input.requestQuestions(questions, AbortSignal.any([callbackOptions.signal, input.signal]));
      if (response === null) return { behavior: "deny", message: "The user dismissed these questions." };
      return { behavior: "allow", updatedInput: { ...toolInput,
        answers: Object.fromEntries(questions.map((question) => [question.question, response.answers[question.id]!.join(", ")])) } };
    };
    return options;
  }
}

function claudePermission(mode: PermissionMode): {
  readonly mode: "plan" | "default" | "bypassPermissions" | "auto";
  readonly approvals: boolean;
  readonly bypass: boolean;
} {
  switch (mode) {
    case "read_only":
      return { mode: "plan", approvals: false, bypass: false };
    case "full_access":
      return { mode: "bypassPermissions", approvals: false, bypass: true };
    case "ask":
      return { mode: "default", approvals: true, bypass: false };
    case "approve_for_me":
      // Omit canUseTool: native auto review owns decisions, and an action
      // requiring manual escalation must not reopen Rack's Ask me dialog.
      return { mode: "auto", approvals: false, bypass: false };
  }
}

interface ClaudeEventState {
  messageId: string;
  nextMessage: number;
  readonly streamed: Map<string, string>;
  readonly tools: Map<number, { id: string; name: string; json: string }>;
}

/** SDK streaming blocks and final messages describe the same content once. */
function mapClaudeMessage(message: unknown, state: ClaudeEventState): RuntimeEvent[] {
  const type = stringField(message, "type");
  if (type === "assistant") {
    const body = recordField(message, "message");
    const messageId = stringField(body, "id") ?? state.messageId;
    return arrayField(body, "content").flatMap((block, index): RuntimeEvent[] => {
      const blockType = stringField(block, "type");
      if (blockType === "text" || blockType === "thinking") {
        const complete = stringField(block, blockType === "text" ? "text" : "thinking");
        if (complete === undefined) return [];
        const key = `${messageId}:${index}:${blockType}`;
        const previous = state.streamed.get(key) ?? "";
        const text = complete.startsWith(previous) ? complete.slice(previous.length) : "";
        state.streamed.set(key, complete);
        if (text === "") return [];
        return blockType === "text" ? [{ type: "message_delta", text }] : [{ type: "thinking_delta", text,
          format: "trace", traceId: `${messageId}:${index}` }];
      }
      if (blockType === "tool_use") {
        const id = stringField(block, "id");
        return [{ type: "tool_request", tool: stringField(block, "name") ?? "tool", input: field(block, "input"),
          ...(id === undefined ? {} : { toolCallId: id }) }];
      }
      // redacted_thinking/signature blocks expose no readable trace text.
      return [];
    });
  }
  if (type === "stream_event") {
    const event = recordField(message, "event");
    const eventType = stringField(event, "type");
    const index = numberField(event, "index") ?? 0;
    if (eventType === "message_start") {
      state.messageId = stringField(recordField(event, "message"), "id") ?? `stream-${state.nextMessage++}`;
      state.tools.clear();
      return [];
    }
    if (eventType === "content_block_start") {
      const block = recordField(event, "content_block");
      // Some SDK streams seed readable content in the start block before
      // sending deltas. Emit it now and include it in final-message deduplication.
      if (block.type === "text" || block.type === "thinking") {
        const text = stringField(block, block.type === "text" ? "text" : "thinking") ?? "";
        state.streamed.set(`${state.messageId}:${index}:${block.type}`, text);
        return text === "" ? [] : block.type === "text" ? [{ type: "message_delta", text }]
          : [{ type: "thinking_delta", text, format: "trace", traceId: `${state.messageId}:${index}` }];
      }
      if (block.type === "tool_use" && typeof block.id === "string") {
        state.tools.set(index, { id: block.id, name: stringField(block, "name") ?? "tool", json: "" });
        return [{ type: "tool_request", tool: stringField(block, "name") ?? "tool", input: block.input ?? {}, toolCallId: block.id }];
      }
    }
    const delta = recordField(event, "delta");
    const deltaType = stringField(delta, "type");
    const text = stringField(delta, "thinking") ?? stringField(delta, "text");
    if ((deltaType === "thinking_delta" || deltaType === "text_delta") && text !== undefined) {
      const blockType = deltaType === "thinking_delta" ? "thinking" : "text";
      const key = `${state.messageId}:${index}:${blockType}`;
      state.streamed.set(key, (state.streamed.get(key) ?? "") + text);
      return blockType === "text" ? [{ type: "message_delta", text }] : [{ type: "thinking_delta", text,
        format: "trace", traceId: `${state.messageId}:${index}` }];
    }
    const tool = state.tools.get(index);
    if (deltaType === "input_json_delta" && tool !== undefined && typeof delta.partial_json === "string") tool.json += delta.partial_json;
    if (eventType === "content_block_stop" && tool !== undefined && tool.json !== "") {
      try {
        return [{ type: "tool_request", tool: tool.name, input: JSON.parse(tool.json) as unknown, toolCallId: tool.id }];
      } catch { /* The final assistant tool block supplies authoritative input. */ }
    }
  }
  if (type === "user") {
    return arrayField(recordField(message, "message"), "content")
      .filter((block) => stringField(block, "type") === "tool_result")
      .map((block): RuntimeEvent => ({ type: "tool_result", output: field(block, "content"),
        ...(stringField(block, "tool_use_id") === undefined ? {} : { toolCallId: stringField(block, "tool_use_id")! }),
        isError: field(block, "is_error") === true }));
  }
  if (type === "result") {
    const subtype = stringField(message, "subtype");
    const usage = recordField(message, "usage");
    const usageEvent: Extract<RuntimeEvent, { type: "usage" }> = { type: "usage" };
    const inputTokens = numberField(usage, "input_tokens");
    const outputTokens = numberField(usage, "output_tokens");
    const costUsd = numberField(message, "total_cost_usd");
    const events: RuntimeEvent[] = [{
      ...usageEvent,
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(costUsd === undefined ? {} : { costUsd }),
    }];
    if (subtype === "success") {
      events.push({ type: "completed", result: stringField(message, "result") ?? "" });
    } else {
      const error = arrayField(message, "errors").map(String).join("; ") || "Claude execution failed.";
      const availability = claudeAvailability(error);
      if (availability !== undefined) {
        events.push(availability);
      }
      events.push({ type: "failed", error, retryable: subtype === "error_during_execution" });
    }
    return events;
  }
  if (type === "rate_limit_event") {
    const info = recordField(message, "rate_limit_info");
    const status = stringField(info, "status");
    const reset = numberField(info, "resetsAt");
    return [{
      type: "availability",
      status: status === "rejected" ? "unavailable" : "available",
      ...(reset === undefined ? {} : { quotaResetAt: new Date(reset * 1000).toISOString() }),
      ...(status === "rejected" ? { reason: "Claude subscription rate limit rejected the request." } : {}),
    }];
  }
  return [];
}

function claudeAvailability(error: string): Extract<RuntimeEvent, { type: "availability" }> | undefined {
  const normalized = error.toLowerCase();
  if (
    normalized.includes("authentication") ||
    normalized.includes("oauth") ||
    normalized.includes("credential") ||
    normalized.includes("login")
  ) {
    return { type: "availability", status: "reauth_required", reason: error };
  }
  if (normalized.includes("rate limit") || normalized.includes("credit") || normalized.includes("quota")) {
    return { type: "availability", status: "unavailable", reason: error };
  }
  return undefined;
}

function stringEnvironment(
  environment: NodeJS.ProcessEnv,
  excluded: ReadonlySet<string> = new Set(),
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !excluded.has(entry[0]),
    ),
  );
}

function recordField(value: unknown, key: string): Record<string, unknown> {
  return record(field(value, key));
}

function arrayField(value: unknown, key: string): readonly unknown[] {
  const candidate = field(value, key);
  return Array.isArray(candidate) ? candidate : [];
}

function field(value: unknown, key: string): unknown {
  return record(value)[key];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function stringField(value: unknown, key: string): string | undefined {
  const candidate = field(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  const candidate = field(value, key);
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
}

const CLAUDE_EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Narrows an application effort value to the SDK's `EffortLevel`. Throwing
 * (inside `startRun`'s try block) fails the attempt with a visible error;
 * silently dropping an unsupported level would run at a different effort
 * than the user chose. The SDK may still downgrade a level the selected
 * model cannot use; that is provider behavior, not Rack's choice.
 */
function claudeEffort(value: string): EffortLevel {
  const level = CLAUDE_EFFORT_LEVELS.find((candidate) => candidate === value);
  if (level === undefined) {
    throw new Error(`Claude does not support reasoning effort '${value}'.`);
  }
  return level;
}

/** Claude's speed options: the SDK's fast mode switched off or on. */
const CLAUDE_SPEEDS: readonly SpeedOption[] = [
  { id: "standard", label: "Standard", fast: false, description: "Claude standard speed" },
  { id: "fast", label: "Fast", fast: true, description: "Claude fast mode, when your plan allows it" },
];

/** Maps a speed option to the SDK flag; unknown values fail the attempt visibly. */
function claudeFastMode(value: string): boolean {
  if (value === "fast") return true;
  if (value === "standard") return false;
  throw new Error(`Claude does not support speed '${value}'.`);
}
