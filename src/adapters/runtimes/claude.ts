import {
  query,
  type Options,
  type PermissionResult,
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
  RuntimeRunInput,
} from "../../core/execution/types.js";

const CLAUDE_FALLBACK_MODELS: readonly RuntimeModel[] = [
  { modelId: "default", displayName: "Default", description: "Claude's recommended model.", isDefault: true },
  { modelId: "opus", displayName: "Opus", description: "Best for complex work." },
  { modelId: "sonnet", displayName: "Sonnet", description: "Balanced quality and speed." },
  { modelId: "haiku", displayName: "Haiku", description: "Fast for quick answers." },
];

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
  ) {}

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

  /**
   * The Agent SDK exposes the same model catalog used by Claude Code through
   * `Query.supportedModels()`. Discovery is account-scoped, so the fallback
   * aliases keep the picker usable before sign-in and on an offline account.
   */
  async models(account?: RuntimeAccountContext): Promise<readonly RuntimeModel[]> {
    if (account === undefined) return CLAUDE_FALLBACK_MODELS;
    let modelQuery: ReturnType<typeof query> | undefined;
    try {
      const credential = await this.credentials.resolve(account.credential);
      const context = await this.contexts.resolve(account.runtimeContextId);
      const environment = {
        ...stringEnvironment(process.env, new Set([
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN",
        ])),
        ...(context.environment === undefined ? {} : context.environment),
        ...credential.environment,
        CLAUDE_CONFIG_DIR: context.directory,
      };
      const options: Options = {
        cwd: process.cwd(),
        env: environment,
        persistSession: false,
      };
      modelQuery = query({ prompt: "", options });
      await modelQuery.initializationResult();
      const discovered = await modelQuery.supportedModels();
      const models = discovered.flatMap((model): RuntimeModel[] => {
        if (typeof model.value !== "string" || model.value === "") return [];
        return [{
          modelId: model.value,
          displayName: model.displayName,
          description: model.description,
          ...(model.value === "default" ? { isDefault: true } : {}),
        }];
      });
      return models.length === 0 ? CLAUDE_FALLBACK_MODELS : models;
    } catch {
      return CLAUDE_FALLBACK_MODELS;
    } finally {
      modelQuery?.close();
    }
  }

  describePermissionMode(mode: PermissionMode): string {
    const permission = claudePermission(mode);
    if (permission.bypass) {
      return `SDK permission mode '${permission.mode}' with dangerous-skip allowed; no approval prompts.`;
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

  private async *run(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
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
    let activeQuery: ReturnType<typeof query> | undefined;
    try {
      const options = this.options(input, environment, sdkAbort);
      activeQuery = query({ prompt: input.prompt, options });
      this.activeQueries.set(input.attemptId, activeQuery);
      for await (const rawMessage of activeQuery) {
        const message: unknown = rawMessage;
        const sessionId = stringField(message, "session_id");
        if (sessionId !== undefined && sessionId !== seenSessionId) {
          seenSessionId = sessionId;
          yield { type: "native_session", nativeSessionId: sessionId };
        }
        yield* mapClaudeMessage(message);
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
      cwd: input.workspacePath,
      env: environment,
      abortController,
      permissionMode: permission.mode,
      ...(input.model === undefined ? {} : { model: input.model }),
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
          ? { behavior: "allow" }
          : { behavior: "deny", message: "The user denied this action." };
      };
    }
    return options;
  }
}

function claudePermission(mode: PermissionMode): {
  readonly mode: "plan" | "default" | "bypassPermissions";
  readonly approvals: boolean;
  readonly bypass: boolean;
} {
  switch (mode) {
    case "read_only":
      return { mode: "plan", approvals: false, bypass: false };
    case "full_access":
      return { mode: "bypassPermissions", approvals: false, bypass: true };
    case "ask":
    case "approve_for_me":
      return { mode: "default", approvals: true, bypass: false };
  }
}

function mapClaudeMessage(message: unknown): RuntimeEvent[] {
  const type = stringField(message, "type");
  if (type === "stream_event") {
    const event = recordField(message, "event");
    const delta = recordField(event, "delta");
    const deltaType = stringField(delta, "type");
    const text = stringField(delta, "text") ?? stringField(delta, "thinking");
    if (text === undefined) return [];
    if (deltaType === "thinking_delta") return [{ type: "thinking_delta", text }];
    if (deltaType === "text_delta") return [{ type: "message_delta", text }];
    return [];
  }
  if (type === "assistant") {
    const content = arrayField(recordField(message, "message"), "content");
    return content.flatMap((block): RuntimeEvent[] => {
      const blockType = stringField(block, "type");
      if (blockType === "text") {
        const text = stringField(block, "text");
        return text === undefined ? [] : [{ type: "message_delta", text }];
      }
      if (blockType === "thinking") {
        const text = stringField(block, "thinking");
        return text === undefined ? [] : [{ type: "thinking_delta", text }];
      }
      if (blockType === "tool_use") {
        return [{
          type: "tool_request",
          tool: stringField(block, "name") ?? "tool",
          input: field(block, "input"),
        }];
      }
      return [];
    });
  }
  if (type === "user") {
    const content = arrayField(recordField(message, "message"), "content");
    return content
      .filter((block) => stringField(block, "type") === "tool_result")
      .map((block) => ({ type: "tool_result", output: field(block, "content") }));
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
