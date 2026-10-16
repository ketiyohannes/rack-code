import { statSync } from "node:fs";
import { win32 } from "node:path";

/**
 * Resolve the Windows native CLI for both authentication and runtime use.
 * Electron cannot directly spawn npm's .cmd/.ps1 launchers. Search PATH in
 * order, then the standard per-user npm prefix (desktop PATH may be stale).
 * No shell is involved and no credentials or user configuration are read.
 * Explicit commands and non-Windows launches retain their existing behavior.
 */
export function resolveCodexCommand(command: string = "codex", options: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly isFile?: (path: string) => boolean;
} = {}): string {
  if (command !== "codex" || (options.platform ?? process.platform) !== "win32") return command;
  const environment = options.environment ?? process.env;
  const env = (name: string): string | undefined => Object.entries(environment)
    .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  const isFile = options.isFile ?? ((path: string) => {
    try { return statSync(path).isFile(); } catch { return false; }
  });
  const directories = (env("PATH") ?? "").split(";")
    .map((path) => path.trim().replace(/^"(.*)"$/, "$1"))
    .filter((path) => win32.isAbsolute(path));
  const appData = env("APPDATA");
  if (appData && win32.isAbsolute(appData)) directories.push(win32.join(appData, "npm"));
  const arch = options.arch ?? process.arch;
  const target = arch === "x64" ? "x86_64-pc-windows-msvc"
    : arch === "arm64" ? "aarch64-pc-windows-msvc" : undefined;

  for (const directory of new Set(directories)) {
    const direct = win32.join(directory, "codex.exe");
    if (isFile(direct)) return direct;
    if (target === undefined) continue;
    // npm has shipped both bundled vendor binaries and optional platform
    // packages, which may be nested under codex or hoisted beside it.
    const scope = win32.join(directory, "node_modules", "@openai");
    const packageName = `codex-win32-${arch}`;
    const roots = [
      win32.join(scope, "codex", "node_modules", "@openai", packageName),
      win32.join(scope, packageName),
      win32.join(scope, "codex"),
    ];
    for (const root of roots) {
      for (const folder of ["bin", "codex"]) {
        const candidate = win32.join(root, "vendor", target, folder, "codex.exe");
        if (isFile(candidate)) return candidate;
      }
    }
  }
  throw new Error("Codex CLI was not found. Install Codex CLI for Windows, then restart Rack and try connecting again.");
}
