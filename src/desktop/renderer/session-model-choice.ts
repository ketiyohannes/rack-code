/**
 * Per-session model, reasoning and speed choices that survive restarts.
 *
 * The composer owns each conversation's unsent selection (see
 * `features/composer-selection.ts`). When a session is first shown in a
 * window, its picker starts from, in order:
 *
 * 1. an explicit choice made in that session's picker (saved here, per device);
 * 2. the session's root history or workflow defaults, so existing sessions
 *    need no migration and the choice follows a session across devices;
 * 3. the most recent explicit choice anywhere (handled by the picker), so a
 *    new session starts with the model last picked.
 *
 * A saved session choice is kept even when its model is no longer offered;
 * the composer then reports it as unavailable instead of silently routing the
 * conversation to another model.
 */
import type { ModelPickerSelection } from "./components/model-picker.js";

const STORAGE_KEY = "composer.sessionModels";
/** Oldest entries are dropped beyond this, so deleted sessions cannot grow storage forever. */
export const MAX_REMEMBERED_SESSIONS = 300;

/**
 * Normalizes one stored entry. Entries written before 2026-10-22 used
 * `modelKey` and a `fast` flag instead of `key` and a speed ID.
 */
function parseChoice(value: unknown): ModelPickerSelection | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  const key = typeof entry["key"] === "string" ? entry["key"] : typeof entry["modelKey"] === "string" ? entry["modelKey"] : undefined;
  if (key === undefined) return undefined;
  const text = (name: string) => typeof entry[name] === "string" ? { [name]: entry[name] as string } : {};
  return {
    key, ...text("label"), ...text("reasoningEffort"), ...text("speed"),
    ...(typeof entry["fast"] === "boolean" ? { fast: entry["fast"] } : {}),
  };
}

/** Insertion-ordered map; re-saving a session moves it to the end. */
function read(): Map<string, ModelPickerSelection> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return new Map();
    const entries: [string, ModelPickerSelection][] = [];
    for (const entry of parsed) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
      const choice = parseChoice(entry[1]);
      if (choice !== undefined) entries.push([entry[0], choice]);
    }
    return new Map(entries);
  } catch { return new Map(); }
}

export function loadSessionChoice(sessionId: string): ModelPickerSelection | undefined {
  return read().get(sessionId);
}

export function saveSessionChoice(sessionId: string, choice: ModelPickerSelection): void {
  const all = read();
  all.delete(sessionId);
  all.set(sessionId, parseChoice(choice)!);
  while (all.size > MAX_REMEMBERED_SESSIONS) all.delete(all.keys().next().value!);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...all])); } catch { /* Keep the in-memory choice. */ }
}
