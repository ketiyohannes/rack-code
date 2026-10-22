/** Editable starting points. Nothing runs or is saved until the user chooses it. */
import type { WorkflowDefinition, WorkflowStep } from "../../../features/orchestration/types.js";
export function agentStep(name = "Agent", instructions = "Complete this step and return a concise result.", access: "read_only" | "inherit" = "inherit"): WorkflowStep {
  return { id: crypto.randomUUID(), name, kind: "agent", agents: [{ id: crypto.randomUUID(), name, instructions, access }] };
}
export function workflowTemplate(kind: "feature" | "review" | "research" = "feature"): WorkflowDefinition {
  const plan = agentStep("Plan", "Understand the request, inspect relevant files and propose a concrete implementation plan. Do not modify files.", "read_only");
  const build = agentStep("Build", "Implement the approved plan. Use earlier review findings when revising. Validate the change and report what changed and which checks passed.");
  const review = { ...agentStep("Review", "Independently review the changes for correctness, regressions and missing validation. Give actionable findings with file references. Do not modify files.", "read_only"), review: { returnTo: build.id, maxRounds: 2 } };
  const parallel = (name: string, roles: readonly [string, string][]): WorkflowStep => ({ id: crypto.randomUUID(), name, kind: "parallel", agents: roles.map(([role, instructions]) => ({ id: crypto.randomUUID(), name: role, instructions, access: "read_only" })) });
  const steps: readonly WorkflowStep[] = kind === "feature" ? [plan, { id: crypto.randomUUID(), name: "Approve the plan", kind: "approval", agents: [] }, build, review]
    : kind === "review" ? [parallel("Independent reviews", [["Correctness", "Review the requested changes for bugs, edge cases and behavior regressions. Cite concrete evidence. Do not edit files."], ["Tests & security", "Review test coverage and security risks in the requested changes. Report concrete findings. Do not edit files."]])]
      : [parallel("Explore in parallel", [["Researcher", "Investigate the user's question. Gather primary evidence and cite sources. Do not modify files."], ["Critical reader", "Independently investigate the question, look for counterexamples and identify uncertainty. Cite sources. Do not modify files."]])];
  return { id: crypto.randomUUID(), name: kind === "feature" ? "Feature development" : kind === "review" ? "Parallel review" : "Research & compare", description: kind === "feature" ? "Plan thoughtfully. Build with approval. Review independently." : kind === "review" ? "Two independent perspectives, one considered review." : "Explore different angles and bring the evidence together.", revision: 0, steps };
}
