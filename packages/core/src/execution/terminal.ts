/** Optional native interactive terminal controls. Runtimes expose this only
 * when their public API can create/control a terminal without a model turn.
 * Presentation and fallback PTYs live outside core execution.
 */
import type { RuntimeAccountContext } from "./types.js";
export interface TerminalProcess {
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}
export interface TerminalStart {
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly onData: (text: string) => void;
  readonly onExit: (code: number) => void;
}
export interface NativeTerminalInput extends TerminalStart { readonly account: RuntimeAccountContext }
