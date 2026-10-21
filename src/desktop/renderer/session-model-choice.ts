/**
 * Per-session model, reasoning and speed choices for the composer.
 *
 * Each session remembers its own composer settings, so switching from a
 * session that uses one model to another that uses a different model also
 * switches the picker. A session's settings come from, in order:
 *
 * 1. an explicit choice made in that session's picker (saved here, per device);
 * 2. the session's latest run, which records provider, model, reasoning
 *    effort and speed, so existing sessions need no migration and the choice
 *    follows a session across devices;
 * 3. the most recent explicit choice anywhere, so a new session starts with
 *    the model last picked.
 *
 * Choices are routing hints, not guarantees: the picker resolves them against
 * the current catalog and favorites and falls back to the default model when
 * the remembered model is unavailable. The stored choice is kept, so it
 * applies again once that model returns.
 */
import type { ModelView, RunView } from "../../contracts/desktop/index.js";
import { modelKey, PROVIDER_DEFAULT } from "./components/model-settings.js";

/** A remembered choice. Either `modelKey`, or `providerId` plus `modelId` (from a run). */
export interface ModelChoice {
  readonly modelKey?: string;
  readonly providerId?: string;
  /** Catalog model ID; runs that used the provider default record no model, which maps to `default`. */
  readonly modelId?: string;
  /** Reasoning stop ID, or `PROVIDER_DEFAULT`. */
  readonly reasoningEffort?: string;
  readonly fast?: boolean;
  /** Speed option ID recorded by a run; used when `fast` is absent. */
  readonly speed?: string;
}

const STORAGE_KEY = "composer.sessionModels";
/** Oldest entries are dropped beyond this, so deleted sessions cannot grow storage forever. */
export const MAX_REMEMBERED_SESSIONS = 300;

interface StoredChoice { readonly modelKey: string; readonly reasoningEffort?: string; readonly fast?: boolean }

/** Insertion-ordered map; re-saving a session moves it to the end. */
function read(): Map<string, StoredChoice> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return new Map();
    const entries = parsed.filter((entry): entry is [string, StoredChoice] => Array.isArray(entry) && typeof entry[0] === "string"
      && typeof entry[1] === "object" && entry[1] !== null && typeof (entry[1] as StoredChoice).modelKey === "string");
    return new Map(entries);
  } catch { return new Map(); }
}

export function loadSessionChoice(sessionId: string): ModelChoice | undefined {
  return read().get(sessionId);
}

export function saveSessionChoice(sessionId: string, choice: StoredChoice): void {
  const all = read();
  all.delete(sessionId);
  all.set(sessionId, {
    modelKey: choice.modelKey,
    ...(choice.reasoningEffort === undefined ? {} : { reasoningEffort: choice.reasoningEffort }),
    ...(choice.fast === undefined ? {} : { fast: choice.fast }),
  });
  while (all.size > MAX_REMEMBERED_SESSIONS) all.delete(all.keys().next().value!);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...all])); } catch { /* Keep the in-memory choice. */ }
}

/**
 * The settings of the session's most recent run, or undefined without runs.
 * Only runs of `sessionId` count: right after a session switch the store may
 * still hold the previous session's runs.
 */
export function choiceFromRuns(sessionId: string, runs: readonly RunView[]): ModelChoice | undefined {
  let latest: RunView | undefined;
  for (const run of runs) {
    if (run.sessionId === sessionId && (latest === undefined || run.createdAt >= latest.createdAt)) latest = run;
  }
  if (latest === undefined) return undefined;
  return {
    providerId: latest.providerId,
    modelId: latest.model ?? "default",
    // An absent effort means the provider default was requested.
    reasoningEffort: latest.reasoningEffort ?? PROVIDER_DEFAULT,
    ...(latest.speed === undefined ? {} : { speed: latest.speed }),
  };
}

/** Stable identity of a fallback, so the picker re-applies it only when it changes. */
export function choiceIdentity(choice: ModelChoice | undefined): string {
  return choice === undefined ? "" : JSON.stringify([choice.modelKey, choice.providerId, choice.modelId, choice.reasoningEffort, choice.fast, choice.speed]);
}

/** The catalog entry a choice names, if it is currently offered. */
export function resolveChoice(models: readonly ModelView[], choice: ModelChoice | undefined): ModelView | undefined {
  if (choice === undefined) return undefined;
  if (choice.modelKey !== undefined) return models.find((entry) => modelKey(entry) === choice.modelKey);
  if (choice.providerId === undefined || choice.modelId === undefined) return undefined;
  return models.find((entry) => entry.providerId === choice.providerId && entry.id === choice.modelId);
}
