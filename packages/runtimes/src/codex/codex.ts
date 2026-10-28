import { codexSkillRoots, skillId } from "../shared/installed-skills.js";
import type {
  CredentialResolver,
  RuntimeContextResolver,
} from "@rack/core/authentication/contracts";
import type {
  PermissionMode,
  RuntimeAccountContext,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEvent,
  ReasoningEffortOption,
  RuntimeModel,
  SpeedOption,
  RuntimeModelInput,
  RuntimeRunInput,
} from "@rack/core/execution/types";
import { JsonRpcProcess, type JsonRpcMessage } from "./json-rpc-process.js";
import { nativeQuestions } from "../shared/user-questions.js";
import type { NativeTerminalInput, TerminalProcess } from "@rack/core/execution/terminal";
import { startAppToolServer } from "../app-tool-server/app-tool-server.js";
import { StringDecoder } from "node:string_decoder";
import { managedCodexCommand } from "./managed-codex-command.js";

type CodexProcessFactory = (options: {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}) => Pick<JsonRpcProcess, "request" | "notify" | "respond" | "respondError" | "nextMessage" | "close">;

interface ActiveCodexRun {
  readonly process: ReturnType<CodexProcessFactory>;
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
  /** Includes startup, before a thread/turn exists and graceful interruption is possible. */
  private readonly processes = new Map<string, ReturnType<CodexProcessFactory>>();
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
    const command = options.command;
    const args = options.args ?? ["app-server", "--stdio"];
    this.createProcess = options.createProcess ?? ((processOptions) =>
      JsonRpcProcess.start(managedCodexCommand(command, processOptions.environment), args, processOptions));
  }

  /**
   * Read every picker-visible catalog page in the saved account's CODEX_HOME.
   * This short-lived server never starts a thread or turn. Failure is surfaced
   * to the host instead of substituting stale, hard-coded model names.
   */
  async models(input: RuntimeModelInput): Promise<readonly RuntimeModel[]> {
    const credential = await this.credentials.resolve(input.account.credential);
    const context = await this.contexts.resolve(input.account.runtimeContextId);
    const child = this.createProcess({
      cwd: input.projectPath ?? context.directory,
      environment: { ...process.env, ...context.environment, ...credential.environment, CODEX_HOME: context.directory },
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Codex model discovery timed out.")), 15_000);
    });
    try {
      return await Promise.race([this.readModels(child), timeout]);
    } finally {
      clearTimeout(timer);
      await child.close();
    }
  }

  /** Native discovery includes account/project/system skills and installed user roots. */
  async skills(input: RuntimeModelInput): Promise<import("@rack/core/execution/types").SkillCatalog> {
    const credential = await this.credentials.resolve(input.account.credential);
    const context = await this.contexts.resolve(input.account.runtimeContextId);
    const child = this.createProcess({ cwd: input.projectPath ?? context.directory, environment: { ...process.env, ...context.environment, ...credential.environment, CODEX_HOME: context.directory } });
    try {
      await child.request("initialize", { clientInfo: { name: "rack", version: "1.0.0" }, capabilities: { experimentalApi: true } }, 10_000);
      child.notify("initialized", {});
      await child.request("skills/extraRoots/set", { extraRoots: codexSkillRoots() }, 10_000);
      const response = asRecord(await child.request("skills/list", { cwds: input.projectPath ? [input.projectPath] : [], forceReload: true }, 15_000));
      if (!Array.isArray(response.data)) throw new Error("Codex returned an invalid skills catalog.");
      const skills: import("@rack/core/execution/types").RuntimeSkill[] = []; const errors: string[] = [];
      for (const raw of response.data) {
        const entry = asRecord(raw);
        for (const rawSkill of Array.isArray(entry.skills) ? entry.skills : []) {
          const skill = asRecord(rawSkill);
          if (typeof skill.name !== "string" || typeof skill.path !== "string") continue;
          skills.push({ id: skillId("codex", skill.path), name: skill.name, description: typeof skill.description === "string" ? skill.description : "", path: skill.path, source: String(skill.scope ?? "Installed"), enabled: skill.enabled !== false });
        }
        for (const error of Array.isArray(entry.errors) ? entry.errors : []) errors.push(String(asRecord(error).message ?? "A skill could not be loaded."));
      }
      return { skills: [...new Map(skills.map((skill) => [skill.id, skill])).values()], errors };
    } finally { await child.close(); }
  }

  private async readModels(child: ReturnType<CodexProcessFactory>): Promise<readonly RuntimeModel[]> {
    await child.request("initialize", {
      clientInfo: { name: "rack", title: "Rack", version: "0.1.0" },
      capabilities: {},
    }, 10_000);
    child.notify("initialized", {});
    const models = new Map<string, RuntimeModel>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = asRecord(await child.request("model/list", {
        limit: 100, includeHidden: false, ...(cursor === undefined ? {} : { cursor }),
      }));
      if (!Array.isArray(response.data)) throw new Error("Codex returned an invalid model catalog.");
      for (const value of response.data) {
        const entry = asRecord(value);
        if (entry.hidden === true) continue;
        const id = typeof entry.model === "string" ? entry.model : entry.id;
        if (typeof id !== "string" || id.trim() === "") continue;
        const current = models.get(id);
        const efforts = codexReasoningEfforts(entry.supportedReasoningEfforts);
        const defaultEffort = typeof entry.defaultReasoningEffort === "string" && efforts.some((effort) => effort.id === entry.defaultReasoningEffort)
          ? entry.defaultReasoningEffort
          : current?.defaultReasoningEffort;
        models.set(id, {
          id, providerId: this.providerId,
          label: typeof entry.displayName === "string" ? entry.displayName : current?.label ?? id,
          ...(typeof entry.description === "string"
            ? { description: entry.description }
            : current?.description === undefined ? {} : { description: current.description }),
          ...(entry.isDefault === true || current?.isDefault === true ? { isDefault: true } : {}),
          ...(efforts.length > 0 ? { reasoningEfforts: efforts } : current?.reasoningEfforts === undefined ? {} : { reasoningEfforts: current.reasoningEfforts }),
          ...(defaultEffort === undefined ? {} : { defaultReasoningEffort: defaultEffort }),
          ...codexSpeeds(entry, current),
        });
      }
      cursor = typeof response.nextCursor === "string" ? response.nextCursor : undefined;
      // A broken provider returning the same cursor must not spin indefinitely.
      if (cursor !== undefined && cursors.has(cursor)) throw new Error("Codex repeated a model catalog cursor.");
      if (cursor !== undefined) cursors.add(cursor);
    } while (cursor !== undefined);
    return [...models.values()];
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
    const policy = codexPermissionPolicy(mode);
    return `Sandbox '${policy.sandbox}', approval policy '${policy.approvalPolicy}', reviewer '${policy.approvalsReviewer}'.`;
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

  /** Reuses Codex's documented PTY controls, with an isolated account context
   * and no thread/model turn. Manual terminal input is user-owned execution.
   */
  async openTerminal(input: NativeTerminalInput): Promise<TerminalProcess> {
    const credential = await this.credentials.resolve(input.account.credential);
    const context = await this.contexts.resolve(input.account.runtimeContextId);
    const child = this.createProcess({ cwd: input.cwd, environment: { ...process.env, ...context.environment, ...credential.environment, CODEX_HOME: context.directory } });
    let closed = false;
    const decoder = new StringDecoder("utf8");
    try {
      await child.request("initialize", { clientInfo: { name: "rack", title: "Rack Terminal", version: "0.1.0" }, capabilities: { experimentalApi: true } }, 10_000);
      child.notify("initialized", {});
      const processId = "rack-terminal";
      let ready!: () => void;
      let fail!: (error: unknown) => void;
      const startup = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
      void startup.catch(() => {});
      void (async () => {
        while (!closed) {
          const next = await child.nextMessage();
          if (next.done) break;
          if (next.value.method === "command/exec/outputDelta") {
            const data = asRecord(next.value.params);
            // Protocol chunks are bytes and can split a Unicode character.
            if (data.processId === processId && typeof data.deltaBase64 === "string") { input.onData(decoder.write(Buffer.from(data.deltaBase64, "base64"))); ready(); }
          }
        }
      })().catch((error: unknown) => { if (!closed) { fail(error); input.onExit(1); } });
      const completion = child.request("command/exec", {
        command: [process.env["SHELL"] ?? "/bin/sh", "-l"], processId, tty: true, streamStdoutStderr: true,
        disableTimeout: true, disableOutputCap: true, cwd: input.cwd, size: { cols: input.cols, rows: input.rows },
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      void completion.then((result) => { if (!closed) { ready(); input.onData(decoder.end()); input.onExit(Number(asRecord(result).exitCode ?? 0)); } }, (error: unknown) => {
        if (!closed) { fail(error); input.onData(`\r\n${error instanceof Error ? error.message : String(error)}\r\n`); input.onExit(1); }
      });
      // Unsupported command APIs normally reject immediately. Don't wait for
      // a prompt forever when a shell's startup scripts produce no output.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([startup, new Promise<void>((resolve) => { timer = setTimeout(resolve, 500); })]); }
      finally { clearTimeout(timer); }
      return {
        write: async (data) => { await child.request("command/exec/write", { processId, deltaBase64: Buffer.from(data).toString("base64") }); },
        resize: async (cols, rows) => { await child.request("command/exec/resize", { processId, size: { cols, rows } }); },
        close: async () => {
          if (closed) return;
          closed = true;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            // A crashed server may never acknowledge termination. Closing the
            // connection also terminates its connection-owned command.
            await Promise.race([child.request("command/exec/terminate", { processId }).catch(() => {}),
              new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); })]);
          } finally { clearTimeout(timer); await child.close(); }
        },
      };
    } catch (error) { closed = true; await child.close(); throw error; }
  }

  async forceCancel(input: Pick<RuntimeRunInput, "attemptId" | "signal">): Promise<void> {
    const child = this.processes.get(input.attemptId);
    await child?.close();
    this.active.delete(input.attemptId);
    this.processes.delete(input.attemptId);
  }

  private async *run(input: RuntimeRunInput, resume: boolean): AsyncIterable<RuntimeEvent> {
    if (input.interactionMode === "plan") input = { ...input, permissionMode: "read_only" };
    const credential = await this.credentials.resolve(input.account.credential);
    const context = await this.contexts.resolve(input.account.runtimeContextId);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...context.environment,
      ...credential.environment,
      CODEX_HOME: context.directory,
    };
    input.signal.throwIfAborted();
    const childProcess = this.createProcess({ cwd: input.projectPath, environment });
    this.processes.set(input.attemptId, childProcess);
    let threadId: string | undefined;
    let turnId: string | undefined;
    let assistantText = "";
    const eventState: CodexEventState = { thinking: new Map<string, string>(), messages: new Map<string, string>(), ...(resume ? {} : { usageBaseline: { inputTokens: 0, outputTokens: 0 } }) };
    const questionRequests = new Map<string, AbortController>();
    let appTools: Awaited<ReturnType<typeof startAppToolServer>>;

    try {
      await childProcess.request("initialize", {
        clientInfo: {
          name: "rack",
          title: "Rack",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      }, 10_000);
      childProcess.notify("initialized", {});

      if (input.skills?.length) await childProcess.request("skills/extraRoots/set", { extraRoots: codexSkillRoots() }, 10_000);
      appTools = await startAppToolServer(input.tools ?? [], input.signal);
      const toolConfig = appTools === undefined ? {} : { config: { mcp_servers: { rack: {
        url: appTools.url, http_headers: { Authorization: `Bearer ${appTools.token}` }, tool_timeout_sec: 3600,
      } } } };
      let threadResponse: unknown;
      if (resume) {
        try {
          threadResponse = await childProcess.request("thread/resume", { ...this.threadResumeParams(input), ...toolConfig });
        } catch (error) {
          // A thread that cannot be opened (typically "no rollout found" for
          // a thread whose first turn never started) is reported as an
          // unavailable continuation so ExecutionService can start a fresh
          // thread with conversation context. Nothing has run yet. Other
          // resume errors (authentication, transport) keep their meaning.
          const message = error instanceof Error ? error.message : String(error);
          if (input.signal.aborted || !isMissingThreadError(message)) throw error;
          yield { type: "failed", error: message, reason: "continuation_unavailable" };
          return;
        }
      } else {
        threadResponse = await childProcess.request("thread/start", { ...this.threadStartParams(input), ...toolConfig });
      }
      threadId = readString(threadResponse, ["thread", "id"])
        ?? input.continuation?.nativeSessionId;
      if (threadId === undefined) {
        throw new Error("Codex did not return a thread id.");
      }

      const collaborationModel = input.model ?? readString(threadResponse, ["model"]);
      if (input.interactionMode === "plan" && !collaborationModel) throw new Error("Codex did not report the model required for Plan mode.");
      const turnResponse = await childProcess.request("turn/start", {
        threadId,
        input: [{ type: "text", text: `${(input.skills ?? []).map((skill) => `$${skill.name}`).join(" ")}${input.skills?.length ? "\n\n" : ""}${input.prompt}` },
          ...(input.skills ?? []).map((skill) => ({ type: "skill", name: skill.name, path: skill.path }))],
        // Always reset the native workflow when leaving a plan on a resumed thread.
        ...(input.interactionMode === undefined || !collaborationModel ? {} : { collaborationMode: { mode: input.interactionMode === "plan" ? "plan" : "default", settings: { model: collaborationModel, reasoning_effort: input.reasoningEffort ?? null, developer_instructions: null } } }),
        cwd: input.projectPath,
        // Override resumed thread settings at the turn boundary as well. The
        // provider owns review; Rack only forwards prompts in Ask me mode.
        approvalPolicy: codexPermissionPolicy(input.permissionMode).approvalPolicy,
        approvalsReviewer: codexPermissionPolicy(input.permissionMode).approvalsReviewer,
        ...(input.model === undefined ? {} : { model: input.model }),
        // `effort` overrides the thread's reasoning effort for this and later
        // turns, so each Rack turn sends its own choice (or none, keeping the
        // model default). Codex validates the value against the model.
        ...(input.reasoningEffort === undefined ? {} : { effort: input.reasoningEffort }),
        // `serviceTierForTurn` applies only to the turn being started and
        // leaves the thread's tier untouched, so each Rack turn carries its
        // own choice. Codex documents "default" as standard speed.
        ...(input.speed === undefined ? {} : { serviceTierForTurn: input.speed }),
      });
      turnId = readString(turnResponse, ["turn", "id"]);
      if (turnId === undefined) {
        throw new Error("Codex did not return a turn id.");
      }
      // Report the thread only after turn/start succeeds. Codex writes a new
      // thread's rollout when its first turn starts; a thread ID reported
      // after thread/start alone would be saved even when that turn fails,
      // and every later resume of it would fail with "no rollout found".
      yield { type: "native_session", nativeSessionId: threadId };
      this.active.set(input.attemptId, { process: childProcess, threadId, turnId });

      for (;;) {
        const next = await childProcess.nextMessage();
        if (next.done) {
          throw new Error("Codex app-server ended before the turn completed.");
        }
        const message = next.value;
        if (message.id !== undefined && message.method !== undefined) {
          if (message.method === "item/tool/requestUserInput" || message.method === "tool/requestUserInput") {
            const params = asRecord(message.params);
            const id = message.id;
            const key = JSON.stringify(id);
            const request = new AbortController();
            questionRequests.set(key, request);
            // Do not park the notification reader. Nonblocking questions can
            // coexist with output, and native resolution must clear the UI.
            void (async () => {
              if (params.threadId !== threadId || params.turnId !== turnId) throw new Error("Question does not belong to the active turn.");
              const questions = nativeQuestions(params, "codex");
              const response = await input.requestQuestions?.(questions, AbortSignal.any([input.signal, request.signal])) ?? null;
              if (questionRequests.get(key) !== request || request.signal.aborted || input.signal.aborted) return;
              childProcess.respond(id, { answers: Object.fromEntries(questions.filter((question) => response?.answers[question.id] !== undefined)
                .map((question) => [question.id, { answers: response!.answers[question.id] }])) });
            })().catch((error: unknown) => {
              if (questionRequests.get(key) === request && !request.signal.aborted) childProcess.respondError(id, error instanceof Error ? error.message : String(error));
            }).finally(() => { if (questionRequests.get(key) === request) questionRequests.delete(key); });
            continue;
          }
          yield* await this.handleServerRequest(childProcess, message, input);
          continue;
        }
        if (message.method === undefined) {
          continue;
        }
        if (message.method === "serverRequest/resolved") {
          const key = JSON.stringify(asRecord(message.params).requestId);
          questionRequests.get(key)?.abort();
          questionRequests.delete(key);
        }
        if (message.method === "thread/tokenUsage/updated") {
          const params = asRecord(message.params);
          // A resumed server can replay another turn's counters. Only this
          // thread/turn contributes observations to the current attempt.
          if ((params.threadId !== undefined && params.threadId !== threadId) || (params.turnId !== undefined && params.turnId !== turnId)) continue;
        }
        const events = mapCodexNotification(message.method, message.params, eventState);
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
      for (const request of questionRequests.values()) request.abort();
      questionRequests.clear();
      this.active.delete(input.attemptId);
      this.processes.delete(input.attemptId);
      await childProcess.close();
      await appTools?.close();
    }
  }

  private threadStartParams(input: RuntimeRunInput): Record<string, unknown> {
    const policy = codexPermissionPolicy(input.permissionMode);
    return {
      cwd: input.projectPath,
      ...(input.model === undefined ? {} : { model: input.model }),
      sandbox: policy.sandbox,
      approvalPolicy: policy.approvalPolicy,
      approvalsReviewer: policy.approvalsReviewer,
    };
  }

  private threadResumeParams(input: RuntimeRunInput): Record<string, unknown> {
    const policy = codexPermissionPolicy(input.permissionMode);
    return {
      threadId: input.continuation?.nativeSessionId,
      cwd: input.projectPath,
      ...(input.model === undefined ? {} : { model: input.model }),
      sandbox: policy.sandbox,
      approvalPolicy: policy.approvalPolicy,
      approvalsReviewer: policy.approvalsReviewer,
    };
  }

  private async *handleServerRequest(
    process: ReturnType<CodexProcessFactory>,
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
      if (input.permissionMode !== "ask") {
        // Never quietly replace automatic/native enforcement with an app
        // prompt or an unconditional allow if the provider routes one here.
        process.respond(message.id, codexApprovalResponse(message.method, "deny", params));
        if (input.permissionMode !== "read_only") {
          throw new Error(`Codex requested manual approval while '${input.permissionMode}' was selected. Its native permission settings could not resolve this action.`);
        }
        return;
      }
      // Command and file-change approvals name the item already reported by
      // `item/started`; permission escalations are not tied to one item.
      const decision = await input.requestApproval({
        tool: message.method,
        input: params,
        ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
        ...(typeof params.itemId === "string" ? { toolCallId: params.itemId } : {}),
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
  readonly approvalsReviewer: "user" | "auto_review";
} {
  switch (mode) {
    case "read_only":
      return { sandbox: "read-only", approvalPolicy: "never", approvalsReviewer: "user" };
    case "full_access":
      return { sandbox: "danger-full-access", approvalPolicy: "never", approvalsReviewer: "user" };
    case "approve_for_me":
      return { sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "auto_review" };
    case "ask":
      return { sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user" };
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

interface CodexEventState {
  readonly thinking: Map<string, string>;
  readonly messages: Map<string, string>;
  usageBaseline?: { inputTokens: number; outputTokens: number };
}

/** Correlate native items and keep summaries separate from exposed trace text. */
function mapCodexNotification(method: string, rawParams: unknown, state: CodexEventState): RuntimeEvent[] {
  const params = asRecord(rawParams);
  const nativeId = typeof params.itemId === "string" ? params.itemId : undefined;
  const callId = nativeId === undefined ? {} : { toolCallId: nativeId };
  switch (method) {
    case "item/plan/delta":
    case "item/agentMessage/delta": {
      if (typeof params.delta !== "string") return [];
      if (nativeId !== undefined) state.messages.set(nativeId, (state.messages.get(nativeId) ?? "") + params.delta);
      return [{ type: "message_delta", text: params.delta }];
    }
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta": {
      if (typeof params.delta !== "string") return [];
      const format = method.includes("summary") ? "summary" : "trace";
      const part = format === "summary" ? params.summaryIndex : params.contentIndex;
      const traceId = nativeId === undefined ? undefined : `${nativeId}:${format}:${typeof part === "number" ? part : 0}`;
      if (traceId !== undefined) state.thinking.set(traceId, (state.thinking.get(traceId) ?? "") + params.delta);
      return [{ type: "thinking_delta", text: params.delta, format, ...(traceId === undefined ? {} : { traceId }) }];
    }
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
      return typeof params.delta === "string" ? [{ type: "tool_output_delta", text: params.delta, ...callId }] : [];
    case "item/started": {
      const item = asRecord(params.item);
      const itemType = typeof item.type === "string" ? item.type : "item";
      if (["agentMessage", "reasoning", "userMessage", "plan", "contextCompaction"].includes(itemType)) return [];
      // MCP calls carry their server, tool and arguments as item fields;
      // expose them through the provider-neutral identity.
      const mcp = itemType === "mcpToolCall" && typeof item.server === "string" && typeof item.tool === "string"
        ? { server: item.server, tool: item.tool, ...(item.arguments === undefined ? {} : { arguments: item.arguments }) } : undefined;
      return [{ type: "tool_request", tool: itemType, input: item,
        ...(typeof item.id === "string" ? { toolCallId: item.id } : {}),
        ...(mcp === undefined ? {} : { mcp }) }];
    }
    case "item/completed": {
      const item = asRecord(params.item);
      if (item.type === "agentMessage" || item.type === "plan") {
        if (typeof item.text !== "string") return [];
        const previous = typeof item.id === "string" ? state.messages.get(item.id) ?? "" : "";
        const text = item.text.startsWith(previous) ? item.text.slice(previous.length) : "";
        return text === "" ? [] : [{ type: "message_delta", text }];
      }
      if (item.type === "reasoning") {
        const events: RuntimeEvent[] = [];
        for (const format of ["trace", "summary"] as const) {
          const parts = format === "trace" ? item.content : item.summary;
          for (const [index, part] of (Array.isArray(parts) ? parts : []).entries()) {
            if (typeof part !== "string" || part === "") continue;
            const traceId = typeof item.id === "string" ? `${item.id}:${format}:${index}` : undefined;
            const previous = traceId === undefined ? "" : state.thinking.get(traceId) ?? "";
            const text = part.startsWith(previous) ? part.slice(previous.length) : "";
            if (text !== "") events.push({ type: "thinking_delta", text, format, ...(traceId === undefined ? {} : { traceId }) });
          }
        }
        return events;
      }
      if (["userMessage", "plan", "contextCompaction"].includes(String(item.type))) return [];
      return [{ type: "tool_result", output: item,
        ...(typeof item.id === "string" ? { toolCallId: item.id } : {}),
        isError: item.status === "failed" || item.status === "declined" || item.success === false
          || (typeof item.exitCode === "number" && item.exitCode !== 0) }];
    }
    case "thread/tokenUsage/updated": {
      const usage = asRecord(params.tokenUsage ?? params);
      const event: Extract<RuntimeEvent, { type: "usage" }> = { type: "usage" };
      const total = asRecord(usage.total);
      const last = asRecord(usage.last);
      const nested = numberValue(total.inputTokens) !== undefined && numberValue(total.outputTokens) !== undefined;
      // Current app-server totals are thread-wide. On resume the first active
      // turn increment establishes the pre-turn baseline (total minus last).
      // All following notifications become cumulative *attempt* counters,
      // including duplicate notifications, rather than re-billing the thread.
      if (nested && state.usageBaseline === undefined) state.usageBaseline = {
        inputTokens: Math.max(0, Number(total.inputTokens) - (numberValue(last.inputTokens) ?? 0)),
        outputTokens: Math.max(0, Number(total.outputTokens) - (numberValue(last.outputTokens) ?? 0)),
      };
      const inputTokens = nested ? Math.max(0, Number(total.inputTokens) - state.usageBaseline!.inputTokens) : numberValue(usage.inputTokens);
      const outputTokens = nested ? Math.max(0, Number(total.outputTokens) - state.usageBaseline!.outputTokens) : numberValue(usage.outputTokens);
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

/**
 * Reads `Model.supportedReasoningEfforts` from `model/list`
 * (`[{ reasoningEffort, description }]`). Codex types the level as a free
 * string, so values are kept as reported; malformed or duplicate entries are
 * skipped rather than failing the whole catalog.
 */
function codexReasoningEfforts(value: unknown): ReasoningEffortOption[] {
  if (!Array.isArray(value)) return [];
  const options: ReasoningEffortOption[] = [];
  for (const raw of value) {
    const entry = asRecord(raw);
    const id = entry.reasoningEffort;
    if (typeof id !== "string" || id.trim() === "" || options.some((option) => option.id === id)) continue;
    options.push({ id, ...(typeof entry.description === "string" && entry.description !== "" ? { description: entry.description } : {}) });
  }
  return options;
}

/** Codex's documented service tier value for standard speed. */
const CODEX_STANDARD_TIER = "default";

/**
 * Reads speed options from `model/list`: `serviceTiers`
 * (`[{ id, name, description }]`) with `defaultServiceTier`, falling back to
 * the deprecated `additionalSpeedTiers` string list. Codex treats a null
 * default as standard speed, so a "Standard" option (`"default"`) is added
 * when the provider lists other tiers, letting the user return to it.
 */
function codexSpeeds(entry: Record<string, unknown>, current: RuntimeModel | undefined): Pick<RuntimeModel, "speeds" | "defaultSpeed"> {
  const tiers: SpeedOption[] = [];
  const add = (id: unknown, name: unknown, description: unknown) => {
    if (typeof id !== "string" || id.trim() === "" || tiers.some((tier) => tier.id === id)) return;
    tiers.push({
      id,
      // Interpret Codex tier semantics here, never by provider ID in the UI.
      ...(id === "priority" || id === "fast" ? { fast: true } : id === CODEX_STANDARD_TIER ? { fast: false } : {}),
      label: typeof name === "string" && name.trim() !== "" ? name : id,
      ...(typeof description === "string" && description !== "" ? { description } : {}),
    });
  };
  if (Array.isArray(entry.serviceTiers)) {
    for (const raw of entry.serviceTiers) {
      const tier = asRecord(raw);
      add(tier.id, tier.name, tier.description);
    }
  } else if (Array.isArray(entry.additionalSpeedTiers)) {
    for (const id of entry.additionalSpeedTiers) add(id, id, undefined);
  }
  if (tiers.length === 0) {
    return current?.speeds === undefined ? {} : { speeds: current.speeds, ...(current.defaultSpeed === undefined ? {} : { defaultSpeed: current.defaultSpeed }) };
  }
  if (!tiers.some((tier) => tier.id === CODEX_STANDARD_TIER)) {
    tiers.unshift({ id: CODEX_STANDARD_TIER, label: "Standard", fast: false, description: "Codex standard speed" });
  }
  const reported = typeof entry.defaultServiceTier === "string" ? entry.defaultServiceTier : CODEX_STANDARD_TIER;
  return { speeds: tiers, defaultSpeed: tiers.some((tier) => tier.id === reported) ? reported : CODEX_STANDARD_TIER };
}

/**
 * Whether a `thread/resume` failure means the native thread does not exist in
 * this CODEX_HOME. Codex reports this as "no rollout found for thread id";
 * other phrasings are matched defensively. Kept narrow so transient or
 * authentication failures are not mistaken for a dead thread.
 */
export function isMissingThreadError(message: string): boolean {
  return /no rollout|rollout[^.]*not found|thread[^.]*not found|unknown thread|no such thread/i.test(message);
}
