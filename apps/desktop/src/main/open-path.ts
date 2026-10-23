/**
 * Resolves and classifies a path the user clicked in the renderer, for
 * Electron main to open. Kept free of Electron APIs so it is unit tested.
 *
 * Paths come from agent output, tool activity, and diffs, so they are
 * untrusted text. Opening a file with its default application can execute
 * it (scripts open in Terminal, `.app` bundles launch, installers run), so
 * anything that could run code is revealed in Finder instead of opened.
 * Ordinary documents, source files, and folders open normally.
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";

export type OpenPathAction =
  /** Open with the default application (folders open in the file manager). */
  | { readonly kind: "open"; readonly path: string }
  /** Select the item in the file manager without opening it. */
  | { readonly kind: "reveal"; readonly path: string }
  | { readonly kind: "missing"; readonly path: string };

/**
 * Extensions whose default "open" executes code or installs software.
 * Directories with these extensions (bundles) are revealed as well.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  ".app", ".command", ".tool", ".terminal", ".sh", ".bash", ".zsh", ".fish", ".csh", ".ksh",
  ".pkg", ".mpkg", ".dmg", ".workflow", ".action", ".scpt", ".scptd", ".applescript", ".jar",
  ".exe", ".bat", ".cmd", ".com", ".msi", ".ps1", ".vbs", ".lnk", ".scr", ".url", ".webloc",
  ".inetloc", ".fileloc", ".prefpane", ".kext", ".plugin", ".bundle", ".framework", ".xpc",
  // Python files can be bound to Python Launcher, which runs them. Other
  // source files (.ts, .js, .rb) open in an editor by default and stay
  // openable; any of them with an execute bit is still revealed.
  ".py", ".pyw",
]);

/**
 * Removes a trailing `:line` or `:line:column` suffix (as printed by
 * compilers and agents) so the file itself can be found.
 */
export function stripLineSuffix(path: string): string {
  return path.replace(/:\d+(?::\d+)?$/, "");
}

/** Expands `~`, then resolves relative paths against `base` (the project folder). */
export function resolveClickedPath(path: string, base: string | undefined, home: string = homedir()): string | undefined {
  const cleaned = stripLineSuffix(path.trim());
  if (cleaned === "") return undefined;
  const expanded = cleaned === "~" ? home : cleaned.startsWith("~/") ? resolve(home, cleaned.slice(2)) : cleaned;
  if (isAbsolute(expanded)) return resolve(expanded);
  return base === undefined || !isAbsolute(base) ? undefined : resolve(base, expanded);
}

/** True when opening the item with its default application could run code. */
export function couldExecute(path: string, mode: number): boolean {
  // Any execute permission bit on a regular file means it can be run.
  return EXECUTABLE_EXTENSIONS.has(extname(path).toLowerCase()) || (mode & 0o111) !== 0;
}

/** Decides how main should handle a click on `path`. */
export async function classifyOpenPath(path: string, base: string | undefined): Promise<OpenPathAction | undefined> {
  const resolved = resolveClickedPath(path, base);
  if (resolved === undefined) return undefined;
  let info;
  try {
    info = await stat(resolved);
  } catch {
    return { kind: "missing", path: resolved };
  }
  if (info.isDirectory()) {
    // Plain folders open in Finder; bundle directories (.app etc.) would launch.
    return EXECUTABLE_EXTENSIONS.has(extname(resolved).toLowerCase()) ? { kind: "reveal", path: resolved } : { kind: "open", path: resolved };
  }
  return couldExecute(resolved, info.mode) ? { kind: "reveal", path: resolved } : { kind: "open", path: resolved };
}
