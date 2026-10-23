import { randomUUID } from "node:crypto";
import type { TerminalProcess, TerminalStart } from "@rack/core/execution/terminal";
import type { TerminalSnapshot, TerminalBackend } from "./types.js";
export type { TerminalSnapshot, TerminalBackend } from "./types.js";

interface OwnedTerminal {
  readonly id: string;
  readonly context: string;
  backend: string;
  output: string;
  offset: number;
  exited: boolean;
  exitCode?: number;
  process?: TerminalProcess;
  closing?: Promise<void>;
  writes: Promise<void>;
}

/** Owns shells independently of renderer attachments. Reopening a context
 * reconnects to its shell, including its exit state. Absolute UTF-16 offsets
 * let clients detect output eviction. Started commands are never retried.
 */
export class TerminalService {
  private readonly terminals = new Map<string, OwnedTerminal>();
  private readonly opening = new Map<string, Promise<TerminalSnapshot>>();
  private stopping = false;

  constructor(private readonly fallback: TerminalBackend) {}

  open(context: string, cwd: string, cols: number, rows: number, native?: TerminalBackend): Promise<TerminalSnapshot> {
    if (this.stopping) return Promise.reject(new Error("Terminals are shutting down."));
    const pending = this.opening.get(context);
    if (pending !== undefined) return pending;
    const existing = [...this.terminals.values()].find((terminal) => terminal.context === context);
    if (existing !== undefined) return Promise.resolve(this.snapshot(existing));
    const operation = this.start(context, cwd, cols, rows, native).finally(() => this.opening.delete(context));
    this.opening.set(context, operation);
    return operation;
  }

  private async start(context: string, cwd: string, cols: number, rows: number, native?: TerminalBackend): Promise<TerminalSnapshot> {
    if (this.terminals.size >= 12) throw new Error("Close an existing terminal before opening another (12 maximum).");
    const terminal: OwnedTerminal = {
      id: randomUUID(), context, backend: "", output: "", offset: 0,
      exited: false, writes: Promise.resolve(),
    };
    this.terminals.set(terminal.id, terminal);
    let source = 0;
    const start = async (backend: TerminalBackend): Promise<TerminalProcess> => {
      const generation = ++source;
      terminal.backend = backend.label;
      terminal.exited = false;
      delete terminal.exitCode;
      const input: TerminalStart = {
        cwd, cols, rows,
        onData: (text) => {
          if (source !== generation) return;
          terminal.output = (terminal.output + text).slice(-262_144);
          terminal.offset += text.length;
        },
        onExit: (code) => {
          if (source !== generation) return;
          terminal.exited = true;
          terminal.exitCode = code;
          // An exited provider PTY may still own an app-server connection.
          // Retain output while releasing native resources promptly.
          void terminal.process?.close().catch(() => {});
        },
      };
      return backend.start(input);
    };
    try {
      try { terminal.process = await start(native ?? this.fallback); }
      catch (error) {
        if (native === undefined) throw error;
        terminal.process = await start(this.fallback);
      }
      if (terminal.exited) await terminal.process.close();
      return this.snapshot(terminal);
    } catch (error) {
      source++;
      this.terminals.delete(terminal.id);
      throw error;
    }
  }

  read(id: string, after = 0): TerminalSnapshot { return this.snapshot(this.get(id), after); }

  /** Preserve key/paste order even when several windows submit input. */
  async write(id: string, data: string): Promise<void> {
    const terminal = this.get(id);
    const operation = terminal.writes.catch(() => {}).then(async () => {
      if (terminal.exited || terminal.closing !== undefined) throw new Error("This terminal has exited. Open a new terminal.");
      await terminal.process!.write(data);
    });
    terminal.writes = operation;
    await operation;
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    const terminal = this.get(id);
    if (!terminal.exited && terminal.closing === undefined) await terminal.process!.resize(cols, rows);
  }

  /** Concurrent and repeated closes release a process only once. */
  async close(id: string): Promise<void> {
    const terminal = this.terminals.get(id);
    if (terminal === undefined) return;
    terminal.closing ??= Promise.resolve().then(async () => {
      await terminal.writes.catch(() => {});
      await terminal.process?.close();
      this.terminals.delete(id);
    }).catch((error: unknown) => { delete terminal.closing; throw error; });
    await terminal.closing;
  }

  async closeContext(context: string): Promise<void> {
    await this.opening.get(context)?.catch(() => {});
    await Promise.all([...this.terminals.values()].filter((terminal) => terminal.context === context).map((terminal) => this.close(terminal.id)));
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.opening.values()]);
    await Promise.allSettled([...this.terminals.keys()].map((id) => this.close(id)));
  }

  private get(id: string): OwnedTerminal {
    const terminal = this.terminals.get(id);
    if (terminal === undefined || terminal.process === undefined) throw new Error("Terminal is not available.");
    return terminal;
  }

  private snapshot(terminal: OwnedTerminal, after = 0): TerminalSnapshot {
    const base = terminal.offset - terminal.output.length;
    const start = Math.max(base, Math.min(after, terminal.offset));
    return {
      id: terminal.id, context: terminal.context, backend: terminal.backend,
      output: terminal.output.slice(start - base), start, offset: terminal.offset,
      exited: terminal.exited, ...(terminal.exitCode === undefined ? {} : { exitCode: terminal.exitCode }),
    };
  }
}
