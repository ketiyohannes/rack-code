import { statSync } from "node:fs";
import { win32 } from "node:path";

/** Resolve Claude's native Windows installation without invoking shell shims.
 * The standard native installer uses ~/.local/bin; desktop PATH can be stale.
 * Explicit commands and other platforms keep the caller's launch semantics.
 */
export function resolveClaudeCommand(command = "claude", environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform): string {
  if (command !== "claude" || platform !== "win32") return command;
  const env = (name: string) => Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  const directories = (env("PATH") ?? "").split(";").map((path) => path.trim().replace(/^"(.*)"$/, "$1"));
  const profile = env("USERPROFILE");
  if (profile) directories.push(win32.join(profile, ".local", "bin"));
  for (const directory of directories.filter((path) => win32.isAbsolute(path))) {
    const candidate = win32.join(directory, "claude.exe");
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* Try the next native location. */ }
  }
  throw new Error("Claude Code was not found. Install the native Claude Code CLI for Windows, then restart Rack.");
}
