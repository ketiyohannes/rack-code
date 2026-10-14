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
import { JsonRpcProcess, type JsonRpcMessage } from "./json-rpc-process.js";

const CODEX_FALLBACK_MODELS: readonly RuntimeModel[] = [
  { modelId: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", description: "Workhorse model for coding and everyday tasks.", isDefault: true },
  { modelId: "gpt-6-astra", displayName: "GPT-6-Astra", description: "Frontier intelligence for demanding work." },
  { modelId: "gpt-6-sol", displayName: "GPT-6-Sol", description: "Previous-generation workhorse model." },
  { modelId: "gpt-6-luna", displayName: "GPT-6-Luna", description: "Fast and affordable for easier tasks." },
];

type CodexProcessFactory = (options: {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}) => JsonRpcProcess;

interface ActiveCodexRun {
  readonly process: JsonRpcProcess;
  readonly threadId: string;
  readonly turnId: string;
}

/**
 * Codex app-server adapter.
 *
 * All app-server method names and payload shapes stay in this file. Core
 * execution sees only the normalized RuntimeEvent contract, which keeps a
 * future runtime adapter from changing account, session, or run logic.
 */
export class CodexRuntimeAdapter implements RuntimeAdapter {
  readonly runtimeId = "codex-app-server";
  readonly providerId = "codex";
  private readonly active = new Map<string, ActiveCodexRun>();
  private readonly createProcess: CodexProcessFactory;

  constructor(
    private readonly credentials: CredentialResolver,
    private readonly contexts: RuntimeContextResolver,
    options: {
      readonly command?: string;
      readonly args?: readonly string[];
      readonly createProcess?: CodexProcessFactory;
    } = {},
  ) {
    const command = options.command ?? "codex";
    const args = options.args ?? ["app-server", "--stdio"];
    this.createProcess = options.createProcess ?? ((processOptions) =>
      JsonRpcProcess.start(command, args, processOptions));
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

  /**
   * Codex exposes its account-aware catalog through `model/list`. When no
   * account has been connected yet, keep the picker useful with the stable
   * local aliases; a signed-in account refresh replaces these with the
   * app-server catalog for that account.
   */
  async models(account?: RuntimeAccountContext): Promise<readonly RuntimeModel[]> {
    if (account === undefined) return CODEX_FALLBACK_MODELS;
    const fallback = CODEX_FALLBACK_MODELS;
    let child: JsonRpcProcess | undefined;
    try {
      const credential = await this.credentials.resolve(account.credential);
      const context = await this.contexts.resolve(account.runtimeContextId);
      child = this.createProcess({
        cwd: process.cwd(),
        environment: {
          ...process.env,
          ...context.environment,
          ...credential.environment,
          CODEX_HOME: context.directory,
        },
      });
      await child.request("initialize", {
        clientInfo: { name: "thinking-and-code", title: "Thinking and Code", version: "0.1.0" },
        capabilities: {},
      });
      child.notify("initialized", {});
      const response = await child.request("model/list", { includeHidden: false });
      const models = asRecord(response).data;
      if (!Array.isArray(models)) return fallback;
      const mapped = models.flatMap((value): RuntimeModel[] => {
        const row = asRecord(value);
        const modelId = typeof row.model === "string" ? row.model : typeof row.id === "string" ? row.id : undefined;
        if (modelId === undefined) return [];
        return [{
          modelId,
          displayName: typeof row.displayName === "string" ? row.displayName : modelId,
          description: typeof row.description === "string" ? row.description : "Codex model",
          ...(row.isDefault === true ? { isDefault: true } : {}),
        }];
      });
      return mapped.length === 0 ? fallback : mapped;
    } catch {
      return fallback;
    } finally {
      await child?.close();
    }
  }

  describePermissionMode(mode: PermissionMode): string {
    const policy = codexPermissionPolicy(mode);
    return `Sandbox '${policy.sandbox}', approval policy '${policy.approvalPolicy}'.`;
  }

  startRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    return this.run(input, false);
  }

  resumeRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    return this.run(input, true);
  }

  async cancel(input: Pick<RuntimeRunInput, "attemptId" | "signal">): Promise<void> {
    const active = this.active.get(input.attemptId);
    if (active === undefined) {
      return;
    }
    try {
      await active.process.request("turn/interrupt", {
        threadId: active.threadId,
        turnId: active.turnId,
      });
    } catch {
      // A provider that already exited is already interrupted from the
      // application's perspective. The execution service records that state.
    }
  }

  private async *run(input: RuntimeRunInput, resume: boolean): AsyncIterable<RuntimeEvent> {
    const credential = await this.credentials.resolve(input.account.credential);
    const context = await this.contexts.resolve(input.account.runtimeContextId);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...context.environment,
      ...credential.environment,
      CODEX_HOME: context.directory,
    };
    const childProcess = this.createProcess({ cwd: input.workspacePath, environment });
    let threadId: string | undefined;
    let turnId: string | undefined;
    let assistantText = "";

    try {
      await childProcess.request("initialize", {
        clientInfo: {
          name: "thinking-and-code",
          title: "Thinking and Code",
          version: "0.1.0",
        },
        capabilities: {},
      });
      childProcess.notify("initialized", {});

      const threadResponse = resume
        ? await childProcess.request("thread/resume", this.threadResumeParams(input))
        : await childProcess.request("thread/start", this.threadStartParams(input));
      threadId = readString(threadResponse, ["thread", "id"])
        ?? input.continuation?.nativeSessionId;
      if (threadId === undefined) {
        throw new Error("Codex did not return a thread id.");
      }
      yield { type: "native_session", nativeSessionId: threadId };

      const turnResponse = await childProcess.request("turn/start", {
        threadId,
        input: [{ type: "text", text: input.prompt }],
        cwd: input.workspacePath,
        ...(input.model === undefined ? {} : { model: input.model }),
      });
      turnId = readString(turnResponse, ["turn", "id"]);
      if (turnId === undefined) {
        throw new Error("Codex did not return a turn id.");
      }
      this.active.set(input.attemptId, { process: childProcess, threadId, turnId });

      for (;;) {
        const next = await childProcess.nextMessage();
        if (next.done) {
          throw new Error("Codex app-server ended before the turn completed.");
        }
        const message = next.value;
        if (message.id !== undefined && message.method !== undefined) {
          yield* await this.handleServerRequest(childProcess, message, input);
          continue;
        }
        if (message.method === undefined) {
          continue;
        }
        const events = mapCodexNotification(message.method, message.params, assistantText);
        for (const event of events) {
          if (event.type === "message_delta") {
            assistantText += event.text;
          }
          yield event;
        }
        if (message.method === "turn/completed") {
          const completion = completionFromTurn(message.params, assistantText);
          if (completion.type === "failed") {
            const availability = codexAvailability(completion.error);
            if (availability !== undefined) {
              yield availability;
            }
          }
          yield completion;
          break;
        }
      }
    } catch (error) {
      if (input.signal.aborted) {
        yield { type: "interrupted" };
      } else {
        yield { type: "failed", error: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      this.active.delete(input.attemptId);
      await childProcess.close();
    }
  }

  private threadStartParams(input: RuntimeRunInput): Record<string, unknown> {
    const policy = codexPermissionPolicy(input.permissionMode);
    return {
      cwd: input.workspacePath,
      ...(input.model === undefined ? {} : { model: input.model }),
      sandbox: policy.sandbox,
      approvalPolicy: policy.approvalPolicy,
    };
  }

  private threadResumeParams(input: RuntimeRunInput): Record<string, unknown> {
    const policy = codexPermissionPolicy(input.permissionMode);
    return {
      threadId: input.continuation?.nativeSessionId,
      cwd: input.workspacePath,
      ...(input.model === undefined ? {} : { model: input.model }),
      sandbox: policy.sandbox,
      approvalPolicy: policy.approvalPolicy,
    };
  }

  private async *handleServerRequest(
    process: JsonRpcProcess,
    message: JsonRpcMessage,
    input: RuntimeRunInput,
  ): AsyncIterable<RuntimeEvent> {
    if (message.id === undefined || message.method === undefined) {
      return;
    }
    if (
      message.method === "item/commandExecution/requestApproval" ||
      message.method === "item/fileChange/requestApproval" ||
      message.method === "item/permissions/requestApproval"
    ) {
      const params = asRecord(message.params);
      const decision = await input.requestApproval({
        tool: message.method,
        input: params,
        ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
      });
      process.respond(message.id, codexApprovalResponse(message.method, decision, params));
      return;
    }
    process.respondError(message.id, `Unsupported Codex server request '${message.method}'.`);
  }
}

function codexPermissionPolicy(mode: PermissionMode): {
  readonly sandbox: "read-only" | "workspace-write" | "danger-full-access";
  readonly approvalPolicy: "untrusted" | "on-request" | "never";
} {
  switch (mode) {
    case "read_only":
      return { sandbox: "read-only", approvalPolicy: "never" };
    case "full_access":
      return { sandbox: "danger-full-access", approvalPolicy: "never" };
    case "ask":
    case "approve_for_me":
      return { sandbox: "workspace-write", approvalPolicy: "on-request" };
  }
}

function codexApprovalResponse(
  method: string,
  decision: "allow" | "deny",
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (method === "item/permissions/requestApproval") {
    return {
      permissions: decision === "allow" ? params.permissions ?? {} : {},
      scope: "turn",
    };
  }
  return { decision: decision === "allow" ? "accept" : "decline" };
}

function mapCodexNotification(
  method: string,
  rawParams: unknown,
  _assistantText: string,
): RuntimeEvent[] {
  const params = asRecord(rawParams);
  switch (method) {
    case "item/agentMessage/delta":
      return typeof params.delta === "string" ? [{ type: "message_delta", text: params.delta }] : [];
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      return typeof params.delta === "string" ? [{ type: "thinking_delta", text: params.delta }] : [];
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
      return [{ type: "tool_result", output: params.delta ?? params }];
    case "item/started": {
      const item = asRecord(params.item);
      const itemType = typeof item.type === "string" ? item.type : "item";
      if (itemType === "agentMessage") {
        return [];
      }
      if (itemType === "reasoning") return [];
      return [{ type: "tool_request", tool: itemType, input: item }];
    }
    case "item/completed":
      return [{ type: "tool_result", output: params.item ?? params }];
    case "thread/tokenUsage/updated": {
      const usage = asRecord(params.tokenUsage ?? params);
      const event: Extract<RuntimeEvent, { type: "usage" }> = { type: "usage" };
      const inputTokens = numberValue(usage.inputTokens);
      const outputTokens = numberValue(usage.outputTokens);
      const costUsd = numberValue(usage.totalCostUsd);
      return [{
        ...event,
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(costUsd === undefined ? {} : { costUsd }),
      }];
    }
    default:
      return [];
  }
}

function completionFromTurn(rawParams: unknown, assistantText: string): RuntimeEvent {
  const turn = asRecord(asRecord(rawParams).turn);
  const status = typeof turn.status === "string" ? turn.status : "completed";
  const error = turn.error;
  if (status === "interrupted" || status === "cancelled") {
    return { type: "interrupted" };
  }
  if (status !== "completed") {
    return {
      type: "failed",
      error: typeof error === "string" ? error : JSON.stringify(error ?? turn),
      retryable: true,
    };
  }
  return { type: "completed", result: assistantText };
}

function codexAvailability(error: string): Extract<RuntimeEvent, { type: "availability" }> | undefined {
  const normalized = error.toLowerCase();
  if (normalized.includes("unauthorized") || normalized.includes("authentication")) {
    return { type: "availability", status: "reauth_required", reason: error };
  }
  if (
    normalized.includes("rate limit") ||
    normalized.includes("usage limit") ||
    normalized.includes("quota") ||
    normalized.includes("credits")
  ) {
    return { type: "availability", status: "unavailable", reason: error };
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function readString(value: unknown, path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const segment of path) {
    current = asRecord(current)[segment];
  }
  return typeof current === "string" ? current : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
