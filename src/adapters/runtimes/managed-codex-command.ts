/** Locate the release-pinned native runtime installed with the application.
 * Launch it directly: Electron cannot rely on a system Node or npm shim.
 * Explicit executable overrides retain their existing discovery behavior.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { statSync } from "node:fs";
import { resolveCodexCommand } from "./codex-command.js";

export function managedCodexCommand(command?: string, environment = process.env): string {
  if (command !== undefined) return resolveCodexCommand(command, { environment });
  return bundledCodexCommand();
}

/** Injectable lookup makes platform layout verification independent of the host. */
export function bundledCodexCommand(options: {
  platform?: string; arch?: string; resolve?: (id: string) => string; isFile?: (path: string) => boolean;
} = {}): string {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : undefined;
  const suffix = { darwin: "apple-darwin", linux: "unknown-linux-musl", win32: "pc-windows-msvc" }[platform];
  if (!cpu || !suffix) throw new Error(`Codex is not supported on ${platform}/${arch}.`);
  try {
    const resolve = options.resolve ?? createRequire(import.meta.url).resolve;
    // Resolve from Codex's package scope to support nested as well as hoisted
    // optional dependencies in production-pruned application packages.
    const runtimeResolve = options.resolve ?? createRequire(resolve("@openai/codex/package.json")).resolve;
    const root = dirname(runtimeResolve(`@openai/codex-${platform}-${arch}/package.json`));
    const binary = join(root, "vendor", `${cpu}-${suffix}`, "bin", platform === "win32" ? "codex.exe" : "codex");
    if (!(options.isFile ?? ((path) => statSync(path).isFile()))(binary)) throw new Error("Missing binary");
    return binary;
  } catch {
    throw new Error("The bundled Codex runtime is missing. Reinstall the app, or run npm ci with optional dependencies when building from source.");
  }
}
