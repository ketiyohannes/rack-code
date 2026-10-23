/**
 * Per-device model favorites. Provider/runtime/model identities share the
 * picker's routing key; labels and connected account IDs are not identities.
 * Keep unavailable favorites so account reconnects/catalog changes restore
 * them, but expose only catalog entries that are currently available.
 */
import type { ModelView } from "@rack/contracts";
import { modelKey } from "./components/model-settings.js";

const STORAGE_KEY = "models.favorites";

/** Invalid/legacy storage is an empty explicit list, never "all models". */
export function parseModelFavorites(value: string | null): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? [...new Set(parsed.filter((key): key is string => typeof key === "string" && key.length > 0))] : [];
  } catch { return []; }
}

export function loadModelFavorites(): readonly string[] {
  try { return parseModelFavorites(localStorage.getItem(STORAGE_KEY)); }
  catch { return []; }
}

/** Storage failure leaves the current in-memory favorite selection usable. */
export function saveModelFavorites(keys: readonly string[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(keys)); }
  catch { /* The preference applies for this renderer session. */ }
}

/** Preserve provider catalog ordering and routing; never add fallback models. */
export function favoriteModels(models: readonly ModelView[], keys: readonly string[]): readonly ModelView[] {
  const favorites = new Set(keys);
  return models.filter((model) => favorites.has(modelKey(model)));
}
