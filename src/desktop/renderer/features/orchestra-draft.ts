/** Field locations supplement the shared definition validator for editor focus.
 * The host still validates every save; these diagnostics never permit a draft
 * that validateWorkflow rejects. No saved schema or execution rules change. */
import { validateWorkflow, type WorkflowDefinition } from "../../../features/orchestration/types.js";

export interface WorkflowDraftIssue {
  readonly message: string;
  readonly field: "Workflow name" | "Workflow description" | "Step name" | "Agent name" | "Agent instructions" | "On review findings" | "Maximum revision rounds";
  readonly stepId?: string;
  readonly agentIndex?: number;
}

export function workflowDraftIssue(draft: WorkflowDefinition): WorkflowDraftIssue | undefined {
  if (!draft.name.trim() || draft.name.length > 100) return { field: "Workflow name", message: "Workflow name must contain 1–100 characters." };
  if (draft.description.length > 4000) return { field: "Workflow description", message: "Workflow description must be at most 4,000 characters." };
  for (const [index, step] of draft.steps.entries()) {
    if (!step.name.trim() || step.name.length > 100) return { stepId: step.id, field: "Step name", message: "Step name must contain 1–100 characters." };
    for (const [agentIndex, agent] of step.agents.entries()) {
      if (!agent.name.trim() || agent.name.length > 100) return { stepId: step.id, agentIndex, field: "Agent name", message: "Agent name must contain 1–100 characters." };
      if (!agent.instructions.trim() || agent.instructions.length > 16000) return { stepId: step.id, agentIndex, field: "Agent instructions", message: `${agent.name} needs instructions containing 1–16,000 characters.` };
    }
    if (step.review) {
      if (!draft.steps.slice(0, index).some((target) => target.id === step.review!.returnTo && target.kind !== "approval")) return { stepId: step.id, field: "On review findings", message: `${step.name} must return to an earlier work step. Move it after its return target or choose a different target.` };
      if (!Number.isInteger(step.review.maxRounds) || step.review.maxRounds < 1 || step.review.maxRounds > 5) return { stepId: step.id, field: "Maximum revision rounds", message: "Choose between one and five revision rounds." };
    }
  }
  try { validateWorkflow(draft); }
  catch (error) { return { field: "Workflow name", message: error instanceof Error ? error.message : String(error) }; }
  return undefined;
}
