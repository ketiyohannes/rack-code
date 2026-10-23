/** App-owned fallback tools. Native shell/file tools stay provider-owned;
 * these add capabilities absent from an integration, such as our shared tab.
 */
export interface AppTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** The owner classifies arguments before execution for read-only/approval checks. */
  readonly isMutation: (arguments_: unknown) => boolean;
  readonly execute: (arguments_: unknown, signal: AbortSignal) => Promise<string>;
}
export interface RuntimeAppTool {
  readonly name: string; readonly description: string; readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly execute: (arguments_: unknown) => Promise<string>;
}
