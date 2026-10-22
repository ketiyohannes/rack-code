/** Rack-owned workflow definitions. Serializable data is shared by the editor,
 * host and scheduler; provider protocols never enter this contract. */
import type { PermissionMode } from "../../core/execution/types.js";

export interface AgentModel {
  readonly providerId: string;
  readonly runtimeId: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

export interface WorkflowAgent {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  /** Missing means use the coordinator/session model. */
  readonly model?: AgentModel;
  readonly access: "read_only" | "inherit";
}

export interface WorkflowStep {
  readonly id: string;
  readonly name: string;
  readonly kind: "agent" | "parallel" | "approval";
  readonly agents: readonly WorkflowAgent[];
  /** A review must finish with VERDICT: APPROVED or VERDICT: CHANGES_REQUESTED. */
  readonly review?: { readonly returnTo: string; readonly maxRounds: number };
}

export interface WorkflowDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly revision: number;
  readonly coordinator?: AgentModel;
  readonly steps: readonly WorkflowStep[];
}

export type WorkflowStatus = "running" | "paused" | "waiting_approval" | "completed" | "failed" | "stopped" | "interrupted";
export interface WorkflowWorker {
  readonly id: string;
  readonly stepId: string;
  readonly name: string;
  readonly instructions: string;
  readonly model: AgentModel;
  readonly status: "queued" | "running" | "completed" | "failed" | "stopped";
  readonly sessionId?: string;
  readonly runId?: string;
  readonly result?: string;
  readonly error?: string;
  readonly round: number;
  readonly createdAt: string;
  readonly finishedAt?: string;
}

export interface WorkflowRun {
  readonly id: string;
  readonly sessionId: string;
  /** An immutable snapshot: editing the library cannot change active work. */
  readonly workflow: WorkflowDefinition;
  readonly prompt: string;
  readonly status: WorkflowStatus;
  readonly stepIndex: number;
  readonly workers: readonly WorkflowWorker[];
  readonly reviewRounds: Readonly<Record<string, number>>;
  readonly defaultModel: AgentModel;
  readonly defaultAccountId?: string;
  readonly permissionMode: PermissionMode;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error?: string;
}

export interface OrchestraSnapshot {
  readonly workflows: readonly WorkflowDefinition[];
  readonly bindings: Readonly<Record<string, string>>;
  readonly runs: readonly WorkflowRun[];
  /** Host-memory designer executions, never persisted as workflow runs. */
  readonly generations?: readonly WorkflowGeneration[];
}

/** Links a designer's live broker requests to its owning editor/root session. */
export interface WorkflowGeneration {
  readonly id: string;
  readonly sessionId: string;
  readonly executionId?: string;
  readonly stopping: boolean;
}

export interface OrchestraStore {
  read(): Promise<OrchestraSnapshot>;
  update(change: (state: OrchestraSnapshot) => OrchestraSnapshot): Promise<unknown>;
}

export const isWorkflowActive = (run: WorkflowRun): boolean => ["running", "paused", "waiting_approval"].includes(run.status);

/** Reject invalid or oversized generated/IPC definitions before storing or running.
 * Parallel workers are read-only in this release: code integration is explicit. */
export function validateWorkflow(value: unknown): WorkflowDefinition {
  if (!value || typeof value !== "object") throw new Error("A workflow definition is required.");
  const definition = value as WorkflowDefinition;
  const text = (input: unknown, limit: number): input is string => typeof input === "string" && input.trim().length > 0 && input.length <= limit;
  const model = (input: AgentModel | undefined) => input === undefined || (!!input && typeof input === "object" && text(input.providerId, 256) && text(input.runtimeId, 256) && text(input.model, 256) && (input.reasoningEffort === undefined || text(input.reasoningEffort, 64)));
  if (!text(definition.id, 256) || !text(definition.name, 100) || typeof definition.description !== "string" || definition.description.length > 4000 || !Number.isSafeInteger(definition.revision) || definition.revision < 0 || !model(definition.coordinator)) throw new Error("Provide a name and a valid coordinator model.");
  if (!Array.isArray(definition.steps) || definition.steps.length < 1 || definition.steps.length > 24) throw new Error("A workflow needs between 1 and 24 steps.");
  const ids = new Set<string>();
  let agents = 0;
  for (const [index, step] of definition.steps.entries()) {
    if (!step || !text(step.id, 256) || step.id === "coordinator" || Object.hasOwn(Object.prototype, step.id) || ids.has(step.id) || !text(step.name, 100) || !["agent", "parallel", "approval"].includes(step.kind) || !Array.isArray(step.agents)) throw new Error("Steps need unique IDs, names and valid types.");
    ids.add(step.id);
    if (step.kind === "approval" ? step.agents.length !== 0 : step.kind === "agent" ? step.agents.length !== 1 : step.agents.length < 2 || step.agents.length > 4) throw new Error("Use one worker per step, or two to four read-only workers in a parallel group.");
    for (const agent of step.agents) {
      if (!agent || !text(agent.id, 256) || ids.has(agent.id) || !text(agent.name, 100) || !text(agent.instructions, 16000) || !model(agent.model) || !["read_only", "inherit"].includes(agent.access)) throw new Error("Each worker needs a unique ID, name, instructions and valid model.");
      if (step.kind === "parallel" && agent.access !== "read_only") throw new Error("Parallel workers must be read-only. Use sequential steps for edits.");
      ids.add(agent.id); agents++;
    }
    if (step.review && (step.kind !== "agent" || !definition.steps.slice(0, index).some((entry) => entry.id === step.review?.returnTo && entry.kind !== "approval") || !Number.isInteger(step.review.maxRounds) || step.review.maxRounds < 1 || step.review.maxRounds > 5)) throw new Error("A review must return to an earlier work step, with one to five revision rounds.");
  }
  if (!agents) throw new Error("Add at least one agent to this workflow.");
  // Clone to sever mutable renderer/model objects from the saved definition.
  return structuredClone(definition);
}
