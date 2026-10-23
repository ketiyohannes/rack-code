import type { TerminalProcess, TerminalStart } from "@rack/core/execution/terminal";
export interface TerminalSnapshot {
  readonly id: string; readonly context: string; readonly backend: string;
  readonly output: string; readonly start: number; readonly offset: number; readonly exited: boolean; readonly exitCode?: number;
}
export interface TerminalBackend { readonly label: string; start(input: TerminalStart): Promise<TerminalProcess> }
