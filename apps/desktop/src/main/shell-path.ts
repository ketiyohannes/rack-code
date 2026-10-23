/**
 * Recovers the user's login-shell PATH for a packaged macOS/Linux app.
 *
 * Apps launched from Finder, the Dock, or a desktop launcher inherit a
 * minimal PATH (for example `/usr/bin:/bin:/usr/sbin:/sbin`), so provider
 * CLIs installed under `~/.local/bin`, Homebrew, or a version manager would
 * not be found when the host starts `codex` or `claude`. This asks the
 * user's login shell for its PATH once at startup and merges it in front of
 * the inherited one.
 *
 * The shell runs non-interactively with a short timeout; any failure keeps
 * the inherited PATH. Markers around the value ignore anything the user's
 * shell profile prints. Windows needs no change: GUI apps there inherit the
 * user PATH.
 */
import { execFileSync } from "node:child_process";
import { delimiter } from "node:path";

const MARKER = "__THINKING_AND_CODE_PATH__";

export function resolveShellPath(inherited: string | undefined = process.env["PATH"]): string | undefined {
  if (process.platform === "win32") return inherited;
  const shell = process.env["SHELL"] || "/bin/zsh";
  try {
    const output = execFileSync(shell, ["-ilc", `printf '%s%s%s' '${MARKER}' "$PATH" '${MARKER}'`], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const shellPath = output.split(MARKER)[1];
    if (shellPath === undefined || shellPath.trim() === "") return inherited;
    const entries = [...shellPath.split(delimiter), ...(inherited ?? "").split(delimiter)].filter((entry) => entry !== "");
    return [...new Set(entries)].join(delimiter);
  } catch {
    return inherited;
  }
}
