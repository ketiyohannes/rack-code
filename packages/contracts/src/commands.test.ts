import assert from "node:assert/strict";
import test from "node:test";

import { isHostCommand, validateCommandParams } from "./commands.js";
import { ContractValidationError } from "./validation.js";

test("only declared commands are accepted", () => {
  assert.equal(isHostCommand("runs.start"), true);
  assert.equal(isHostCommand("constructor"), false);
  assert.equal(isHostCommand("toString"), false);
  assert.equal(isHostCommand(42), false);
});

test("parameters are validated, optional keys are omitted, and extra keys rejected", () => {
  assert.deepEqual(validateCommandParams("projects.changes", { projectId: "project" }), { projectId: "project" });
  assert.throws(() => validateCommandParams("projects.changes", { path: "/arbitrary" }), ContractValidationError);
  const params = validateCommandParams("projects.create", { path: "/x", startingRevision: undefined });
  assert.deepEqual(params, { path: "/x" });

  assert.throws(() => validateCommandParams("projects.create", { path: "/x", kind: "other" }), ContractValidationError);
  assert.throws(() => validateCommandParams("runs.cancel", { runId: "r", extra: 1 }), /runs?|extra/);
  assert.throws(() => validateCommandParams("runs.start", null), ContractValidationError);
  assert.throws(
    () => validateCommandParams("accounts.register", {
      providerId: "a",
      providerAccountId: "b",
      credential: { id: "c", providerId: "a" },
      runtimeContextId: "d",
    }),
    /credential\.method/,
  );
});

test("parameterless commands accept undefined", () => {
  assert.deepEqual(validateCommandParams("accounts.list", undefined), {});
});

test("workflow drafting requires a request identity shared by cancellation", () => {
  const params = { sessionId: "root", generationId: "designer-request", description: "Plan and build", model: { providerId: "provider", runtimeId: "runtime", model: "model" } };
  assert.deepEqual(validateCommandParams("orchestra.generate", params), params);
  assert.deepEqual(validateCommandParams("orchestra.cancelGeneration", { generationId: "designer-request" }), { generationId: "designer-request" });
  assert.throws(() => validateCommandParams("orchestra.generate", { ...params, generationId: undefined }), ContractValidationError);
  assert.throws(() => validateCommandParams("orchestra.cancelGeneration", { runId: "hidden-run" }), ContractValidationError);
});

test("session removal accepts only an explicit saved-session identity", () => {
  assert.deepEqual(validateCommandParams("sessions.remove", { sessionId: "saved" }), { sessionId: "saved" });
  for (const value of [{}, { sessionId: "" }, { sessionId: 3 }, { sessionId: "saved", path: "/project" }]) {
    assert.throws(() => validateCommandParams("sessions.remove", value), ContractValidationError);
  }
});

test("question answers have a bounded explicit shape and cancellation is distinct from an answer", () => {
  const base = { runId: "r", requestId: "q" };
  assert.deepEqual(validateCommandParams("runs.respondToQuestions", { ...base, response: null }), { ...base, response: null });
  assert.deepEqual(validateCommandParams("runs.respondToQuestions", { ...base, response: { answers: { format: ["Short"] } } }).response,
    { answers: { format: ["Short"] } });
  for (const response of [{ answers: { format: [1] } }, { answers: { format: [""] } }, { answers: {}, allow: true }, { answers: [] }]) {
    assert.throws(() => validateCommandParams("runs.respondToQuestions", { ...base, response }), ContractValidationError);
  }
});

test("standalone chats and workflow/skills fields are validated without granting arbitrary skill paths", () => {
  assert.deepEqual(validateCommandParams("sessions.create", {}), {});
  assert.deepEqual(validateCommandParams("runs.start", { sessionId: "chat", providerId: "codex", runtimeId: "codex-app-server", prompt: "Help", permissionMode: "ask", interactionMode: "plan", skillIds: ["known"] }), { sessionId: "chat", providerId: "codex", runtimeId: "codex-app-server", prompt: "Help", permissionMode: "ask", interactionMode: "plan", skillIds: ["known"] });
  assert.throws(() => validateCommandParams("skills.list", { sessionId: "chat", runtimeId: "codex-app-server", accountId: "account", path: "/forged" }), ContractValidationError);
  assert.throws(() => validateCommandParams("runs.start", { sessionId: "chat", providerId: "codex", runtimeId: "codex-app-server", prompt: "Help", permissionMode: "ask", interactionMode: "invalid" }), ContractValidationError);
});

test("queue and edit commands validate their parameters", () => {
  const settings = { providerId: "codex", runtimeId: "codex-app-server", permissionMode: "ask", skillIds: ["known"] };
  assert.deepEqual(validateCommandParams("queue.add", { sessionId: "s", prompt: "Next", settings }), { sessionId: "s", prompt: "Next", settings });
  // Attachment-only items have an empty prompt; core requires text or files.
  assert.deepEqual(validateCommandParams("queue.add", { sessionId: "s", prompt: "", attachmentIds: ["f"], settings }).attachmentIds, ["f"]);
  assert.throws(() => validateCommandParams("queue.add", { sessionId: "s", prompt: "x", settings: { ...settings, permissionMode: "everything" } }), ContractValidationError);
  // Plan approvals and sessions cannot be smuggled into stored settings.
  assert.throws(() => validateCommandParams("queue.add", { sessionId: "s", prompt: "x", settings: { ...settings, approvedPlanRunId: "r" } }), ContractValidationError);
  assert.throws(() => validateCommandParams("queue.add", { sessionId: "s", prompt: "x" }), ContractValidationError);
  assert.deepEqual(validateCommandParams("queue.update", { sessionId: "s", itemId: "i", prompt: "Edited" }), { sessionId: "s", itemId: "i", prompt: "Edited" });
  assert.deepEqual(validateCommandParams("queue.remove", { sessionId: "s", itemId: "i" }), { sessionId: "s", itemId: "i" });
  assert.deepEqual(validateCommandParams("queue.sendNow", { sessionId: "s", itemId: "i" }), { sessionId: "s", itemId: "i" });
  assert.deepEqual(validateCommandParams("queue.resume", { sessionId: "s" }), { sessionId: "s" });
  assert.throws(() => validateCommandParams("queue.resume", { sessionId: "s", itemId: "i" }), ContractValidationError);
  assert.deepEqual(validateCommandParams("runs.edit", { runId: "r", prompt: "Reworded" }), { runId: "r", prompt: "Reworded" });
  assert.throws(() => validateCommandParams("runs.edit", { runId: "r", prompt: "x", model: "other" }), ContractValidationError);
});
