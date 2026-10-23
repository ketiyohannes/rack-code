import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { AsyncQueue } from "@rack/core/shared/async-queue";

export interface JsonRpcMessage {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message: string; readonly data?: unknown };
}

/** Typed deadline failure lets callers explain a timeout without exposing RPC output. */
export class ProviderRequestTimeoutError extends Error {
  constructor(method: string) { super(`Provider ${method} timed out. Restart the provider and try again.`); }
}

/**
 * Line-delimited JSON-RPC transport for local provider runtimes.
 *
 * The transport owns process lifetime and request correlation. Provider
 * adapters interpret method names and payloads above this boundary.
 */
export class JsonRpcProcess {
  private readonly messages = new AsyncQueue<JsonRpcMessage>();
  private readonly pending = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private nextId = 1;
  private closed = false;
  private closing: Promise<void> | undefined;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.receive(line));
    // Providers write diagnostics to stderr independently of the JSON-RPC
    // stream. Consume it even when the host does not display diagnostics so a
    // verbose provider cannot fill the pipe and deadlock the run.
    child.stderr.on("data", () => undefined);
    child.on("error", (error) => this.fail(error));
    child.stdin.on("error", (error) => this.fail(error));
    child.on("close", (code, signal) => {
      this.fail(new Error(`Provider process exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}.`));
    });
  }

  static start(command: string, args: readonly string[], options: {
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
  }): JsonRpcProcess {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.environment,
      // Give each owned provider a process group so shutdown also stops its tools.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return new JsonRpcProcess(child);
  }

  /** Optional deadline is for bounded control requests, never long-running turns
   * or commands. Expiry closes the transport because its state is uncertain.
   */
  async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) throw new Error("Provider process is closed.");
    const id = this.nextId++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    if (timeoutMs !== undefined) timer = setTimeout(() => {
      this.fail(new ProviderRequestTimeoutError(method));
      // Preserve the control-request deadline and close the owned process group,
      // even though fail() already marked this transport closed.
      void this.close();
    }, timeoutMs);
    try { this.write({ id, method, params }); } catch (error) {
      this.fail(error instanceof Error ? error : new Error("Provider write failed."));
    }
    try { return await result; } finally { clearTimeout(timer); }
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  respond(id: string | number, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: string | number, message: string, code = -32000): void {
    this.write({ id, error: { code, message } });
  }

  async nextMessage(): Promise<IteratorResult<JsonRpcMessage>> {
    return this.messages.next();
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      // A deadline can close the transport before the OS process exits. Always
      // complete bounded native cleanup, including any owned descendant tools.
      // Reject requests *before* marking closed. In particular, initialize or
      // turn/interrupt may be awaiting an acknowledgment that will never arrive.
      this.fail(new Error("Provider process was closed."));
      const signal = (kind: NodeJS.Signals) => {
        if (process.platform !== "win32" && this.child.pid !== undefined) {
          try { process.kill(-this.child.pid, kind); return; } catch { /* The group may already be gone. */ }
        }
        this.child.kill(kind);
      };
      const waitForExit = async () => {
        if (this.child.exitCode !== null || this.child.signalCode !== null) return;
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); this.child.off("close", done); resolve(); };
          const timer = setTimeout(done, 500);
          this.child.once("close", done);
        });
      };
      signal("SIGTERM");
      await waitForExit();
      // Even if the parent exited promptly, tools in its group can ignore TERM.
      signal("SIGKILL");
      // Retain main's wait-before-config-cleanup guarantee after forced shutdown.
      await waitForExit();
    })();
  }

  private write(message: JsonRpcMessage): void {
    if (this.closed || this.child.stdin.destroyed) {
      throw new Error("Provider process is closed.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    if (line.trim() === "") {
      return;
    }
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    this.messages.push(message);
  }

  private fail(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.messages.fail(error);
  }
}
