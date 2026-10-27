/**
 * Reference scenario for the tool group card: "Is anything blocking the 2.8
 * release?" answered with four MCP calls, one of which needs approval.
 *
 * Used by the reducer tests (as a timed event log) and by the native desktop
 * demo `apps/desktop/scripts/verify-tool-groups.ts`, whose fixture runtime
 * plays the same steps with real delays and asks for approval through the
 * real `requestApproval` callback. Keeping one source means the test and the
 * demo check the same labels, summaries and timing.
 *
 * Tool names use Claude's native MCP spelling (`mcp__github__search_issues`)
 * plus the provider-neutral `mcp` identity, exactly as the Claude adapter
 * reports them; the formatter registry reads only the neutral identity.
 *
 * Expected timing: 1.2s + 760ms + 420ms + 620ms of tool execution = 3.0s.
 * The wait for a person between the approval request and Allow is excluded.
 */
import type { RuntimeEvent } from "@rack/contracts/views";

export const RELEASE_PROMPT = "Is anything blocking the 2.8 release?";

/** One scripted step; `delayMs` is the pause before it. */
export type ScenarioStep =
  | { readonly delayMs: number; readonly event: RuntimeEvent }
  | {
    readonly delayMs: number;
    /** Ask for approval through the runtime's real permission callback. */
    readonly approval: { readonly toolCallId: string; readonly tool: string; readonly input: Readonly<Record<string, unknown>> };
  };

const mcpCall = (id: string, server: string, tool: string, args: Readonly<Record<string, unknown>>): RuntimeEvent =>
  ({ type: "tool_request", tool: `mcp__${server}__${tool}`, input: args, toolCallId: id, mcp: { server, tool, arguments: args } });

const textResult = (id: string, value: unknown): RuntimeEvent =>
  ({ type: "tool_result", toolCallId: id, output: [{ type: "text", text: JSON.stringify(value) }], isError: false });

const SEARCH_ARGS = { query: "repo:arc-ui/web is:issue is:open label:release-2.8 label:blocker" };
const PROJECT_ARGS = { name: "Web 2.8 release" };
const MIGRATION_ARGS = { sql: "select name, author from pending_migrations where release = '2.8' order by created_at" };
const POST_ARGS = { channel: "release", username: "Arc agent", text: "2.8 is blocked by ARC-311 (Safari checkout crash) and ARC-318 (unsigned macOS build). Two migrations are still pending review." };

export const FINAL_ANSWER = [
  "Yes. Two issues are blocking 2.8:\n\n",
  "- **ARC-311** Checkout crashes on Safari 17 (blocked on a WebKit workaround)\n",
  "- **ARC-318** The macOS build is unsigned (blocked on the new certificate)\n\n",
  "Two migrations are also still pending: `20261020_release_flags` and `20261022_audit_index`. ",
  "I posted this summary to #release.",
];

export const RELEASE_SCENARIO: readonly ScenarioStep[] = [
  { delayMs: 0, event: { type: "message_delta", text: "Let me check what is blocking the release." } },
  { delayMs: 300, event: mcpCall("call-search", "github", "search_issues", SEARCH_ARGS) },
  { delayMs: 1200, event: textResult("call-search", { total_count: 4, items: [
    { number: 2311, title: "Checkout crashes on Safari 17" }, { number: 2318, title: "macOS build is unsigned" },
    { number: 2290, title: "Flaky visual test on the pricing page" }, { number: 2302, title: "Release notes draft" },
  ] }) },
  { delayMs: 50, event: mcpCall("call-project", "linear", "get_project", PROJECT_ARGS) },
  { delayMs: 760, event: textResult("call-project", { name: "Web 2.8 release", issues: [
    { identifier: "ARC-311", title: "Checkout crashes on Safari 17", state: { name: "Blocked" } },
    { identifier: "ARC-318", title: "macOS build is unsigned", state: { name: "Blocked" } },
    { identifier: "ARC-305", title: "Pricing page polish", state: { name: "In Progress" } },
    { identifier: "ARC-299", title: "Release notes", state: { name: "In Review" } },
  ] }) },
  { delayMs: 50, event: mcpCall("call-migrations", "postgres", "query", MIGRATION_ARGS) },
  { delayMs: 420, event: textResult("call-migrations", { rows: [
    { name: "20261020_release_flags", author: "dana" }, { name: "20261022_audit_index", author: "lee" },
  ] }) },
  { delayMs: 70, event: mcpCall("call-post", "slack", "post_message", POST_ARGS) },
  { delayMs: 20, approval: { toolCallId: "call-post", tool: "mcp__slack__post_message", input: POST_ARGS } },
  // After Allow, the post itself takes 620ms.
  { delayMs: 620, event: textResult("call-post", { ok: true, channel: "C0RELEASE", ts: "1761580000.000100" }) },
  ...FINAL_ANSWER.map((text, index): ScenarioStep => ({ delayMs: index === 0 ? 80 : 60, event: { type: "message_delta", text } })),
  { delayMs: 0, event: { type: "completed", result: FINAL_ANSWER.join("") } },
];

/** The header title a viewer sees as the scenario plays, in order (consecutive duplicates removed). */
export const RELEASE_HEADER_SEQUENCE = [
  "Using 1 tool", "Using 2 tools", "Using 3 tools", "Using 4 tools", "Waiting for approval", "Using 4 tools", "Used 4 tools",
];

/** The header's right-hand detail once the group is done: its tool time. */
export const RELEASE_HEADER_DETAIL = "3.0s";

/** Row labels and right-hand text once the scenario has finished. */
export const RELEASE_FINAL_ROWS = [
  { label: "Searched issues in arc-ui/web", summary: "4 results", duration: "1.2s" },
  { label: "Read the Web 2.8 release project", summary: "2 blocked", duration: "760ms" },
  { label: "Queried pending migrations", summary: "2 rows", duration: "420ms" },
  { label: "Posted to #release", summary: "Sent", duration: "620ms" },
];

export const RELEASE_APPROVAL = { action: "Post a message to #release", consequence: "Sends as Arc agent to everyone in #release" };

/** Error reported by the failing migrations query in `RELEASE_FAILURE_SCENARIO`. */
export const MIGRATION_ERROR = "Connection to app_production timed out after 5s";

/**
 * The same question when the database is unreachable: the third call fails,
 * the group finishes with "1 failed", and the failed row offers Retry.
 */
export const RELEASE_FAILURE_SCENARIO: readonly ScenarioStep[] = [
  ...RELEASE_SCENARIO.slice(0, 6),
  { delayMs: 50, event: mcpCall("call-migrations", "postgres", "query", MIGRATION_ARGS) },
  { delayMs: 420, event: { type: "tool_result", toolCallId: "call-migrations", output: [{ type: "text", text: MIGRATION_ERROR }], isError: true } },
  { delayMs: 80, event: { type: "message_delta", text: "Two issues are blocking 2.8 (ARC-311 and ARC-318). I could not reach the production database to check pending migrations." } },
  { delayMs: 0, event: { type: "completed", result: "Two issues are blocking 2.8 (ARC-311 and ARC-318). I could not reach the production database to check pending migrations." } },
];

/** How the failed row reads. */
export const RELEASE_FAILED_ROW = { label: "Could not query pending migrations", subtitle: MIGRATION_ERROR };

/**
 * The scenario as a timed event log, as a journal replay would deliver it.
 * The approval is answered `decision` after `approvalWaitMs`.
 */
export function releaseEventLog(options: { readonly decision?: "allow" | "deny"; readonly approvalWaitMs?: number; readonly start?: number } = {}): readonly { readonly event: RuntimeEvent; readonly at: number }[] {
  const decision = options.decision ?? "allow";
  let at = options.start ?? Date.parse("2026-10-27T10:00:00.000Z");
  const log: { event: RuntimeEvent; at: number }[] = [];
  for (const step of RELEASE_SCENARIO) {
    at += step.delayMs;
    if ("event" in step) {
      // A denied post never runs, so its result and the answer that reports it are not part of a denied log.
      if (decision === "deny" && step.event.type === "tool_result" && step.event.toolCallId === "call-post") continue;
      log.push({ event: step.event, at });
      continue;
    }
    log.push({ event: { type: "approval_request", request: { id: "approval-1", ...step.approval } }, at });
    at += options.approvalWaitMs ?? 1500;
    log.push({ event: { type: "approval_resolved", approvalId: "approval-1", decision }, at });
  }
  return log;
}
