/**
 * Surfaces that can open in the right panel.
 *
 * "Changes" is a core surface and always listed. Plugin surfaces appear in
 * the blank-tab launcher and + menu; choosing one enables it if needed. Plugins
 * marked `preview` add a placeholder surface with no functionality yet.
 * Timeline, Browser, Terminal and Files are functional. Retrospective and
 * orchestration remain previews.
 *
 * Enablement is a renderer preference stored per device and only controls
 * whether an open tool stays available. Timeline has automatic project observers
 * with host-owned Pause/Resume plus independently opted-in session chains;
 * hiding the surface does not stop either. Moving this toggle to the host (so
 * composition can validate dependencies and stop workers, as the
 * architecture describes) remains open; see docs/timeline.md.
 */
import type { IconName } from "./icons.js";

export interface SurfaceDefinition {
  readonly id: string;
  readonly title: string;
  readonly icon: IconName;
  /** Legacy shortcut label retained for surface metadata. */
  readonly shortcut: string;
  readonly kind: "core" | "plugin";
  readonly description: string;
  /** Placeholder plugin without functionality; shows a "Preview" tag. */
  readonly preview?: boolean;
}

export const SURFACES: readonly SurfaceDefinition[] = [
  { id: "changes", title: "Changes", icon: "git-diff", shortcut: "D", kind: "core", description: "Current project changes and Git diffs." },
  { id: "run-details", title: "Run details", icon: "list-bullets", shortcut: "R", kind: "core", description: "Run status, account, model, permissions and journal." },
  { id: "terminal", title: "Terminal", icon: "terminal-window", shortcut: "T", kind: "plugin", description: "Interactive project shell, using provider controls when available." },
  { id: "browser", title: "Browser", icon: "globe", shortcut: "B", kind: "plugin", description: "A live browser shared between you and the agent." },
  { id: "files", title: "Files", icon: "files", shortcut: "F", kind: "plugin", description: "Browse, edit and save project files." },
  { id: "timeline", title: "Timeline", icon: "clock-counter-clockwise", shortcut: "L", kind: "plugin", description: "Project history and automatic file change recording." },
  { id: "retrospective", title: "Retrospective", icon: "lightbulb", shortcut: "R", kind: "plugin", preview: true, description: "Post-run analysis and environment observations." },
  { id: "orchestration", title: "Orchestration", icon: "flow-arrow", shortcut: "O", kind: "plugin", preview: true, description: "Multi-stage workflows across models and providers." },
];

const STORAGE_KEY = "plugins.enabled";

export function loadEnabledPlugins(): readonly string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    const known = new Set(SURFACES.filter((surface) => surface.kind === "plugin").map((surface) => surface.id));
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string" && known.has(id)) : [];
  } catch {
    return [];
  }
}

export function saveEnabledPlugins(ids: readonly string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // A lost preference only hides plugin surfaces again.
  }
}
