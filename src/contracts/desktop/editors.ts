/** Desktop-shell editor choices. IDs are allowlisted in main, never commands
 * or command-line arguments provided by renderer/provider content.
 */
export interface EditorTarget { readonly id: string; readonly label: string }
export interface OpenEditorRequest {
  readonly editorId: string;
  readonly path: string;
  readonly base?: string;
}
export type OpenEditorResult = "opened" | "missing" | "unavailable" | "invalid" | "cancelled";
