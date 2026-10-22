import assert from "node:assert/strict";
import test from "node:test";
import { loadSessionChoice, MAX_REMEMBERED_SESSIONS, saveSessionChoice } from "./session-model-choice.js";

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

test("each session keeps its own explicit choice, and old sessions are evicted", () => withStorage(() => {
  saveSessionChoice("opus-session", { key: "claude|claude-runtime|opus", label: "Opus", reasoningEffort: "high" });
  saveSessionChoice("gpt-session", { key: "codex|codex-runtime|gpt", label: "GPT", reasoningEffort: "low", speed: "priority" });
  assert.deepEqual(loadSessionChoice("opus-session"), { key: "claude|claude-runtime|opus", label: "Opus", reasoningEffort: "high" });
  assert.deepEqual(loadSessionChoice("gpt-session"), { key: "codex|codex-runtime|gpt", label: "GPT", reasoningEffort: "low", speed: "priority" });
  assert.equal(loadSessionChoice("new-session"), undefined);
  for (let index = 0; index < MAX_REMEMBERED_SESSIONS; index++) saveSessionChoice(`filler-${index}`, { key: "x" });
  assert.equal(loadSessionChoice("opus-session"), undefined, "the oldest entry is dropped first");
  assert.ok(loadSessionChoice(`filler-${MAX_REMEMBERED_SESSIONS - 1}`));
}));

test("choices saved by the earlier format are still restored", () => withStorage(() => {
  localStorage.setItem("composer.sessionModels", JSON.stringify([
    ["legacy", { modelKey: "claude|claude-runtime|opus", reasoningEffort: "high", fast: true }],
    ["broken", { reasoningEffort: "low" }],
  ]));
  assert.deepEqual(loadSessionChoice("legacy"), { key: "claude|claude-runtime|opus", reasoningEffort: "high", fast: true });
  assert.equal(loadSessionChoice("broken"), undefined, "entries without a model are ignored");
}));

test("corrupt storage is ignored instead of breaking the composer", () => withStorage(() => {
  localStorage.setItem("composer.sessionModels", "{not json");
  assert.equal(loadSessionChoice("any"), undefined);
  saveSessionChoice("any", { key: "k" });
  assert.deepEqual(loadSessionChoice("any"), { key: "k" });
}));
