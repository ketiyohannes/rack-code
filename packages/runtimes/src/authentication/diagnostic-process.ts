import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { ConnectContext } from "@rack/core/connections/ports";

/** Fixed diagnostic failure categories keep raw CLI output and secrets out of UI. */
export class DiagnosticProcessError extends Error {
  constructor(readonly reason: "timeout" | "launch" | "output" | "exit") { super(reason); }
}

/** Resolve a bare POSIX command for an exact diagnostic location. Windows
 * native resolution happens in the provider adapter before this helper.
 */
export function diagnosticExecutable(command: string, environment: NodeJS.ProcessEnv, cwd: string): string {
  if (isAbsolute(command)) return command;
  if (command.includes("/") || command.includes("\\")) return resolve(cwd, command);
  for (const directory of (environment["PATH"] ?? "").split(delimiter).filter((path) => isAbsolute(path))) {
    const path = join(directory, command);
    try { accessSync(path, constants.X_OK); if (statSync(path).isFile()) return path; } catch { /* Continue PATH search. */ }
  }
  throw new DiagnosticProcessError("launch");
}

/** Run a short CLI probe without a shell. Bound time/output, drain stderr without
 * retaining it, and kill timed-out processes. Callers interpret exit codes and
 * whitelist parsed fields; stdout must never be displayed as an error message.
 */
export function probeProcess(command: string, args: readonly string[], cwd: string,
  env: NodeJS.ProcessEnv, timeoutMs = 10_000): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: DiagnosticProcessError, code: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve({ stdout, code });
    };
    const timer = setTimeout(() => finish(new DiagnosticProcessError("timeout")), timeoutMs);
    child.stdin.on("error", () => undefined);
    child.stdin.end();
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > 65_536) { finish(new DiagnosticProcessError("output")); return; }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", () => undefined);
    child.on("error", () => finish(new DiagnosticProcessError("launch")));
    child.on("close", (code) => finish(undefined, code));
  });
}

/** Installation-only checks use disposable config, never the user's default login.
 * Saved-account checks use exactly the context authorized by Connections.
 */
export async function diagnosticContext<T>(context: ConnectContext | undefined,
  check: (context: ConnectContext) => Promise<T>): Promise<T> {
  if (context !== undefined) return check(context);
  const directory = await mkdtemp(join(tmpdir(), "rack-provider-check-"));
  try { return await check({ directory, runtimeContextId: "diagnostic" }); }
  finally { await rm(directory, { recursive: true, force: true, maxRetries: 3 }); }
}

/** Only a version token is displayable; CLI output can contain arbitrary text. */
export function diagnosticVersion(stdout: string): string | undefined {
  return stdout.trim().match(/^(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)(?:\s|$)/)?.[1];
}
