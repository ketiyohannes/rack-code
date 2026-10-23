import assert from "node:assert/strict";
import test from "node:test";
import type { RunView } from "@rack/contracts";
import { INITIAL_STATE } from "../store.js";
import { initialComposerSelection } from "./composer-selection.js";
import { resolveModelSelectionKey } from "../components/model-settings.js";

const root: RunView = { id: "run", sessionId: "chat", providerId: "provider", accountId: "account", prompt: "Task", model: "one", reasoningEffort: "high", speed: "fast", permissionMode: "ask", status: "completed", attemptIds: ["attempt"], attempts: [{ id: "attempt", runId: "run", runtimeId: "runtime", providerId: "provider", accountId: "account", status: "completed", createdAt: "2026-01-01", updatedAt: "2026-01-01" }], createdAt: "2026-01-01", updatedAt: "2026-01-01" };

test("session initialization restores routing and settings from its last root execution", () => {
  const other = { ...root, sessionId: "other", model: "two", createdAt: "2026-02-01" };
  const state = { ...INITIAL_STATE, runs: [root, other] };
  assert.deepEqual(initialComposerSelection(state, "chat"), {
    model: { key: "provider|runtime|one", label: "one", reasoningEffort: "high", speed: "fast" },
    account: "account:provider:account", permissionMode: "ask",
  });
  assert.equal(initialComposerSelection(state, "other").model?.key, "provider|runtime|two");
  assert.equal(initialComposerSelection(state, "new").model, undefined);
});

test("unavailable previous routing is retained, rather than replaced by an available favorite", () => {
  const state = { ...INITIAL_STATE, runs: [root], models: [{ id: "two", label: "Two", providerId: "provider", providerName: "Provider", runtimeId: "runtime", accountIds: ["account"], isDefault: true }], favoriteModelKeys: ["provider|runtime|two"] };
  assert.equal(initialComposerSelection(state, "chat").model?.key, "provider|runtime|one");
  assert.equal(initialComposerSelection({ ...state, runs: [{ ...root, model: undefined }] } as unknown as typeof state, "chat").model?.key, "provider|runtime|two");
});

test("symbolic default resolves after late discovery without replacing concrete unavailable choices", () => {
  const catalog = [{ id: "one", label: "One", providerId: "provider", providerName: "Provider", runtimeId: "runtime", accountIds: ["account"] }];
  const key = "provider|runtime|default";
  assert.equal(resolveModelSelectionKey([], key), key);
  assert.equal(resolveModelSelectionKey(catalog, key), "provider|runtime|one");
  assert.equal(resolveModelSelectionKey(catalog, "provider|runtime|missing"), "provider|runtime|missing");
});
