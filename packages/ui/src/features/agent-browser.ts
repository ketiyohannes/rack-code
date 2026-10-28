/**
 * Recognizes the agent moving the shared browser to a page, so the renderer
 * can bring the Browser tab forward. The agent drives a native page that is
 * only visible through that tab; without this the user had to open it by hand
 * to watch, or to step in (for example to sign in).
 */
import type { RuntimeEvent } from "@rack/contracts/views";

/** Actions that change the page shown. Reads and in-page input do not reveal. */
const PAGE_ACTIONS: ReadonlySet<string> = new Set(["navigate", "back", "forward", "reload"]);

/**
 * True when `event` is the agent asking `rack_browser` to change page. Claude
 * names the tool `mcp__rack__rack_browser`; Codex reports an MCP identity
 * (server "rack", tool "rack_browser") whose arguments may sit apart from the
 * native input.
 */
export function revealsBrowserPage(event: RuntimeEvent): boolean {
  if (event.type !== "tool_request") return false;
  const isBrowser = event.mcp !== undefined
    ? event.mcp.server === "rack" && event.mcp.tool === "rack_browser"
    : event.tool === "rack_browser" || event.tool === "mcp__rack__rack_browser";
  if (!isBrowser) return false;
  const args = event.mcp?.arguments ?? event.input;
  const action = typeof args === "object" && args !== null ? (args as { readonly action?: unknown }).action : undefined;
  return typeof action === "string" && PAGE_ACTIONS.has(action);
}
