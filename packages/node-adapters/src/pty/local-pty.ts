import type { TerminalBackend } from "@rack/features/terminal";
import type { TerminalProcess, TerminalStart } from "@rack/core/execution/terminal";

/** Local fallback for integrations without a public interactive-terminal API.
 * The addon is loaded only when a shell is opened, keeping headless startup
 * independent of native build availability. It owns a real PTY, not pipes.
 */
export class LocalPtyBackend implements TerminalBackend {
  readonly label = "Local shell";
  async start(input: TerminalStart): Promise<TerminalProcess> {
    const pty = await import("node-pty");
    const shell = process.platform === "win32" ? process.env["COMSPEC"] ?? "powershell.exe" : process.env["SHELL"] ?? "/bin/sh";
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"].includes(entry[0])));
    const child = pty.spawn(shell, process.platform === "win32" ? [] : ["-l"], {
      name: "xterm-256color", cols: input.cols, rows: input.rows, cwd: input.cwd, env: { ...environment, TERM: "xterm-256color" },
    });
    child.onData(input.onData);
    child.onExit(({ exitCode }) => input.onExit(exitCode));
    let closed = false;
    return {
      write: async (data) => { if (!closed) child.write(data); },
      resize: async (cols, rows) => { if (!closed) child.resize(cols, rows); },
      close: async () => { if (!closed) { closed = true; child.kill(); } },
    };
  }
}
