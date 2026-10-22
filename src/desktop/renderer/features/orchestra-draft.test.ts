import assert from "node:assert/strict";
import test from "node:test";
import { workflowTemplate } from "./orchestra-templates.js";
import { workflowDraftIssue } from "./orchestra-draft.js";

test("a review moved ahead of its return target identifies the invalid field", () => {
  const draft = workflowTemplate();
  const moved = { ...draft, steps: [draft.steps[3]!, ...draft.steps.slice(0, 3)] };
  const issue = workflowDraftIssue(moved);
  assert.equal(issue?.stepId, draft.steps[3]!.id);
  assert.equal(issue?.field, "On review findings");
  assert.match(issue!.message, /earlier work step/);
});

test("diagnostics locate empty worker instructions and workflow names", () => {
  const draft = workflowTemplate();
  assert.equal(workflowDraftIssue({ ...draft, name: " " })?.field, "Workflow name");
  const first = draft.steps[0]!;
  const issue = workflowDraftIssue({ ...draft, steps: [{ ...first, agents: [{ ...first.agents[0]!, instructions: "" }] }, ...draft.steps.slice(1)] });
  assert.equal(issue?.field, "Agent instructions");
  assert.equal(issue?.agentIndex, 0);
  assert.equal(issue?.stepId, first.id);
  assert.equal(workflowDraftIssue(draft), undefined);
});
