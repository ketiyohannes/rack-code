import assert from "node:assert/strict";
import test from "node:test";
import type { ModelView, RunView } from "../../contracts/desktop/index.js";
import { PROVIDER_DEFAULT } from "./components/model-settings.js";
import { choiceFromRuns, loadSessionChoice, MAX_REMEMBERED_SESSIONS, resolveChoice, saveSessionChoice } from "./session-model-choice.js";

/** In-memory localStorage for the duration of one test. */
function withStorage(run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  try { run(); } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

const model = (providerId: string, id: string, runtimeId = `${providerId}-runtime`): ModelView =>
  ({ id, label: id, providerId, providerName: providerId, runtimeId, accountIds: [] }) as unknown as ModelView;
const run = (sessionId: string, createdAt: string, fields: Partial<RunView>): RunView =>
  ({ id: `${sessionId}-${createdAt}`, sessionId, createdAt, providerId: "codex", accountId: "a", prompt: "", status: "completed", attemptIds: [], permissionMode: "ask", updatedAt: createdAt, ...fields }) as unknown as RunView;

test("each session keeps its own explicit choice, and old sessions are evicted", () => withStorage(() => {
  saveSessionChoice("opus-session", { modelKey: "claude|claude-runtime|opus", reasoningEffort: "high", fast: false });
  saveSessionChoice("gpt-session", { modelKey: "codex|codex-runtime|gpt", reasoningEffort: "low", fast: true });
  assert.deepEqual(loadSessionChoice("opus-session"), { modelKey: "claude|claude-runtime|opus", reasoningEffort: "high", fast: false });
  assert.deepEqual(loadSessionChoice("gpt-session"), { modelKey: "codex|codex-runtime|gpt", reasoningEffort: "low", fast: true });
  assert.equal(loadSessionChoice("new-session"), undefined);
  for (let index = 0; index < MAX_REMEMBERED_SESSIONS; index++) saveSessionChoice(`filler-${index}`, { modelKey: "x" });
  assert.equal(loadSessionChoice("opus-session"), undefined, "the oldest entry is dropped first");
  assert.ok(loadSessionChoice(`filler-${MAX_REMEMBERED_SESSIONS - 1}`));
}));

test("corrupt storage is ignored instead of breaking the composer", () => withStorage(() => {
  localStorage.setItem("composer.sessionModels", "{not json");
  assert.equal(loadSessionChoice("any"), undefined);
  saveSessionChoice("any", { modelKey: "k" });
  assert.deepEqual(loadSessionChoice("any"), { modelKey: "k" });
}));

test("a session without an explicit choice follows its own latest run", () => {
  const runs = [
    run("a", "2026-10-21T10:00:00Z", { providerId: "claude", model: "opus", reasoningEffort: "high" }),
    run("a", "2026-10-21T11:00:00Z", { providerId: "codex", model: "gpt", reasoningEffort: "low", speed: "priority" }),
    // A later run of another session (still in the store during a switch) is ignored.
    run("b", "2026-10-21T12:00:00Z", { providerId: "claude", model: "sonnet" }),
  ];
  assert.deepEqual(choiceFromRuns("a", runs), { providerId: "codex", modelId: "gpt", reasoningEffort: "low", speed: "priority" });
  // Runs that used provider defaults record neither model nor effort.
  assert.deepEqual(choiceFromRuns("c", [run("c", "2026-10-21T10:00:00Z", { providerId: "claude" })]),
    { providerId: "claude", modelId: "default", reasoningEffort: PROVIDER_DEFAULT });
  assert.equal(choiceFromRuns("none", runs), undefined);
});

test("choices resolve only against offered models", () => {
  const offered = [model("codex", "gpt"), model("claude", "opus")];
  assert.equal(resolveChoice(offered, { modelKey: "claude|claude-runtime|opus" })?.id, "opus");
  assert.equal(resolveChoice(offered, { providerId: "codex", modelId: "gpt" })?.id, "gpt");
  assert.equal(resolveChoice(offered, { providerId: "codex", modelId: "opus" }), undefined, "provider and model must both match");
  assert.equal(resolveChoice(offered, { modelKey: "claude|claude-runtime|unstarred" }), undefined);
  assert.equal(resolveChoice(offered, undefined), undefined);
});
