import type { CredentialReference } from "../authentication/index.js";
import type { SessionAttachment } from "../sessions/attachments.js";
import type { UserQuestion, UserQuestionRequest, UserQuestionResponse } from "./question-types.js";
import type { NativeTerminalInput, TerminalProcess } from "./terminal.js";
import type { RuntimeAppTool } from "./app-tools.js";
export type { UserQuestion, UserQuestionRequest, UserQuestionResponse } from "./question-types.js";

export type RunId = string;
export type AttemptId = string;

export type PermissionMode = "read_only" | "ask" | "approve_for_me" | "full_access";

/** Workflow is independent of the user's eventual execution permissions. */
export type InteractionMode = "normal" | "plan";
/** Native skill reference; only adapters discover paths and core validates IDs. */
export interface RuntimeSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly source: string;
  readonly enabled: boolean;
}
export interface SkillCatalog { readonly skills: readonly RuntimeSkill[]; readonly errors: readonly string[] }

export type RunStatus = "queued" | "running" | "completed" | "failed" | "interrupted" | "unknown";
export type AttemptStatus = "queued" | "running" | "completed" | "failed" | "interrupted" | "unknown";

export interface ApprovalRequest {
  readonly id: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly reason?: string;
}

export type ApprovalDecision = "allow" | "deny";

export interface RuntimeAccountContext {
  readonly accountId: string;
  readonly providerId: string;
  readonly credential: CredentialReference;
  readonly runtimeContextId: string;
}

export interface RuntimeContinuation {
  readonly nativeSessionId: string;
  /** Last Rack message this native thread has seen; informational for adapters. */
  readonly seenThroughMessageId?: string;
}

export interface RuntimeRunInput {
  readonly runId: RunId;
  readonly attemptId: AttemptId;
  readonly sessionId: string;
  readonly account: RuntimeAccountContext;
  /**
   * Working directory for the run: the project folder for shared sessions,
   * or the session's worktree for isolated ones. Adapters pass it as the
   * provider's cwd and must not substitute another folder.
   */
  readonly projectPath: string;
  /**
   * Root of the main checkout when `projectPath` is an isolated worktree.
   * Adapters whose provider can load trusted project configuration from the
   * main checkout (Claude's `projectConfigRoot`) use it; others ignore it.
   */
  readonly checkoutRoot?: string;
  readonly prompt: string;
  readonly model?: string;
  /**
   * Reasoning effort chosen from the model's `reasoningEfforts`. Omitted
   * means the provider default. Adapters forward it to the native control
   * and must fail the attempt rather than silently drop an unsupported value.
   */
  readonly reasoningEffort?: string;
  /**
   * Speed option chosen from the model's `speeds`. Omitted means the
   * provider default. Like effort, adapters forward it to the native control
   * and fail the attempt rather than silently ignore an unsupported value.
   */
  readonly speed?: string;
  readonly permissionMode: PermissionMode;
  readonly interactionMode?: InteractionMode;
  readonly skills?: readonly RuntimeSkill[];
  /** The completed plan explicitly approved for this implementation turn. */
  readonly approvedPlanRunId?: string;
  readonly continuation?: RuntimeContinuation;
  readonly signal: AbortSignal;
  readonly requestApproval: (request: Omit<ApprovalRequest, "id">) => Promise<ApprovalDecision>;
  /** Optional for older adapter clients; ExecutionService always supplies it. */
  readonly requestQuestions?: (questions: readonly UserQuestion[], signal?: AbortSignal) => Promise<UserQuestionResponse | null>;
  /** Optional app capabilities supplied explicitly by composition. */
  readonly tools?: readonly RuntimeAppTool[];
}

export interface RuntimeCapabilities {
  readonly resume: boolean;
  readonly fork: boolean;
  readonly approvals: boolean;
  readonly quotaReporting: boolean;
  readonly browserTools: boolean;
  readonly computerUse: boolean;
}

/** A selectable model exposed by a runtime adapter. */
export interface RuntimeModel {
  readonly id: string;
  readonly label: string;
  readonly providerId: string;
  readonly description?: string;
  /** Provider-recommended default; the actual model ID is still sent on execution. */
  readonly isDefault?: boolean;
  /**
   * Reasoning effort levels the provider reports for this model, in the
   * provider's order (typically lowest to highest). Absent or empty means
   * the model has no selectable effort. IDs are provider values (for example
   * "low", "high", "xhigh") passed back unchanged in `RuntimeRunInput`.
   */
  readonly reasoningEfforts?: readonly ReasoningEffortOption[];
  /** The provider's default level for this model, when it reports one. */
  readonly defaultReasoningEffort?: string;
  /**
   * Speed options the provider reports for this model (for example Codex
   * service tiers, or Claude standard/fast mode). Absent or empty means the
   * model has no selectable speed. Eligibility, pricing, and fallback for a
   * speed are provider behavior; the app only passes the choice through.
   */
  readonly speeds?: readonly SpeedOption[];
  /** The provider's default speed for this model, when it reports one. */
  readonly defaultSpeed?: string;
}

/** One selectable speed option, labelled by the provider or its adapter. */
export interface SpeedOption {
  /** Adapter-owned mapping for the compact Fast switch; absent means no binary mapping. */
  readonly fast?: boolean;
  /** Provider value, sent unchanged when the option is chosen. */
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

/** One selectable reasoning effort level. */
export interface ReasoningEffortOption {
  /** Provider value, sent unchanged when the level is chosen. */
  readonly id: string;
  /** Provider-supplied explanation, when available. */
  readonly description?: string;
}

/** Discovery uses the same isolated account context as execution, without a model turn. */
export interface RuntimeModelInput {
  readonly account: RuntimeAccountContext;
  readonly projectPath?: string;
}

export type RuntimeEvent =
  | { readonly type: "message_delta"; readonly text: string }
  | { readonly type: "thinking_delta"; readonly text: string; readonly format?: "trace" | "summary"; readonly traceId?: string }
  | { readonly type: "tool_request"; readonly tool: string; readonly input: unknown; readonly toolCallId?: string }
  | { readonly type: "tool_output_delta"; readonly text: string; readonly toolCallId?: string }
  | { readonly type: "tool_result"; readonly output: unknown; readonly toolCallId?: string; readonly isError?: boolean }
  | { readonly type: "approval_request"; readonly request: ApprovalRequest }
  | { readonly type: "question_request"; readonly request: UserQuestionRequest }
  | { readonly type: "question_resolved"; readonly requestId: string; readonly response: UserQuestionResponse | null }
  | { readonly type: "native_session"; readonly nativeSessionId: string }
  | { readonly type: "usage"; readonly inputTokens?: number; readonly outputTokens?: number; readonly costUsd?: number }
  | { readonly type: "availability"; readonly status: "available" | "unavailable" | "reauth_required"; readonly reason?: string; readonly quotaResetAt?: string }
  | { readonly type: "completed"; readonly result: string; readonly metadata?: Readonly<Record<string, unknown>> }
  /**
   * `reason: "continuation_unavailable"` means a resumed native thread could
   * not be opened (for example Codex reports no rollout for the thread ID)
   * before the turn did any work. ExecutionService then discards the stale
   * association and starts a fresh native thread with conversation context
   * inside the same attempt, instead of failing every later run.
   */
  | { readonly type: "failed"; readonly error: string; readonly retryable?: boolean; readonly reason?: "continuation_unavailable" }
  | { readonly type: "interrupted" };

export interface RuntimeAdapter {
  readonly runtimeId: string;
  /** Stable provider identity used for account selection and model routing. */
  readonly providerId?: string;
  /** Native shell control without a model turn, when publicly supported. */
  readonly openTerminal?: (input: NativeTerminalInput) => Promise<TerminalProcess>;
  /** Discovers selectable models for this account/project; rejects on provider failure. */
  readonly models?: (input: RuntimeModelInput) => Promise<readonly RuntimeModel[]>;
  readonly skills?: (input: RuntimeModelInput) => Promise<SkillCatalog>;
  capabilities(account: RuntimeAccountContext): Promise<RuntimeCapabilities>;
  startRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent>;
  resumeRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent>;
  cancel(input: Pick<RuntimeRunInput, "attemptId" | "signal">): Promise<void>;
  /** Closes the attempt-owned native process when graceful interruption stalls. */
  forceCancel?(input: Pick<RuntimeRunInput, "attemptId" | "signal">): Promise<void>;
  /**
   * Human-readable description of the native controls this adapter applies
   * for an application permission mode. The same app mode maps to different
   * provider settings, so clients display this text instead of inferring the
   * mapping from a provider or runtime name.
   */
  describePermissionMode(mode: PermissionMode): string;
}

export interface RunRecord {
  /** Session-owned copies selected for this turn; persisted for transcript rendering. */
  readonly attachments?: readonly SessionAttachment[];
  readonly id: RunId;
  readonly sessionId: string;
  /** Absent for a standalone chat. */
  readonly projectId?: string;
  readonly prompt: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly model?: string;
  /** Requested reasoning effort; absent means the provider default. */
  readonly reasoningEffort?: string;
  /** Requested speed option; absent means the provider default. */
  readonly speed?: string;
  readonly permissionMode: PermissionMode;
  readonly interactionMode?: InteractionMode;
  readonly skills?: readonly RuntimeSkill[];
  /** The completed plan explicitly approved for this implementation turn. */
  readonly approvedPlanRunId?: string;
  readonly status: RunStatus;
  readonly attemptIds: readonly AttemptId[];
  readonly result?: string;
  readonly error?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AttemptRecord {
  readonly id: AttemptId;
  readonly runId: RunId;
  readonly runtimeId: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly status: AttemptStatus;
  readonly nativeSessionId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface JournalEntry {
  readonly sequence: number;
  readonly runId: RunId;
  readonly attemptId: AttemptId;
  readonly type: RuntimeEvent["type"] | "run_started" | "attempt_started" | "run_status";
  readonly payload: unknown;
  readonly observedAt: string;
}

/** Minimal audit projection: analytics never needs prompts, attachments or tool output. */
export interface RunUsage {
  readonly run: Pick<RunRecord, "id" | "projectId" | "providerId" | "model" | "status" | "createdAt">;
  readonly usage: readonly JournalEntry[];
}
