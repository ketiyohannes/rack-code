/**
 * Independent color palette and light, dark, or system appearance.
 *
 * The preference is a per-device renderer convenience, so it lives in
 * `localStorage` rather than in host records. `system` defers to the OS via
 * the `prefers-color-scheme` media query in styles.css; `light` and `dark`
 * pin the mode with `data-theme`. `data-palette` supplies paired light/dark
 * tokens, so the same palette follows system appearance without JS listeners.
 */
export type ThemePreference = "system" | "light" | "dark";
export type ThemePalette = "neutral" | "emerald" | "burgundy" | "purple" | "flexoki";

const STORAGE_KEY = "appearance";
const PALETTE_KEY = "appearance.palette";

/** Legacy appearance preferences retain their mode and use the neutral palette. */
export function loadPalette(): ThemePalette {
  try {
    const stored = localStorage.getItem(PALETTE_KEY);
    return stored === "emerald" || stored === "burgundy" || stored === "purple" || stored === "flexoki" ? stored : "neutral";
  } catch {
    return "neutral";
  }
}

/** Apply immediately even if device storage is unavailable. */
export function applyPalette(palette: ThemePalette): void {
  document.documentElement.dataset["palette"] = palette;
  try {
    localStorage.setItem(PALETTE_KEY, palette);
  } catch {
    // Storage can be unavailable; the choice still applies for this session.
  }
}

export function loadTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(preference: ThemePreference): void {
  document.documentElement.dataset["theme"] = preference;
  // Both entry points (main shell and snapshot viewer) restore the full
  // appearance through this call. Do not overwrite an in-memory palette if
  // storage was unavailable when the user selected it.
  document.documentElement.dataset["palette"] ??= loadPalette();
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Storage can be unavailable; the choice still applies for this session.
  }
}
