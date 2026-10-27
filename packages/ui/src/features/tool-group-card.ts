/**
 * Tool group card: one collapsible block per group of consecutive tool calls.
 *
 * Layout and motion follow the Orchestration waterfall: no box around the
 * group, a plain header line (stacked tool icons, a title such as "Using 3
 * tools" or "Used 4 tools", and once done the tool time or "1 failed" on the
 * right), then rows joined by a thin rail. Rows drop in, staggered when
 * several arrive together. Each row: tool icon on the rail, label in the
 * right tense (shimmering while it runs), result summary and duration, and a
 * status mark (arc spinner, check, warning). While the group is active and no
 * call is in flight, a shimmering "Working..." row closes the rail. A failed call
 * reads "Could not ...", shows its error on a second line and, once the turn
 * has finished, offers Retry. Each row expands to its raw arguments, output
 * and error. A call that needs permission shows its action, consequence and
 * Deny/Allow on its own row; answering it calls the host's real approval
 * command, and the row then continues like any other.
 *
 * The card is a stateful DOM object rather than a function of state: the
 * session view keeps one instance per group and calls `update` on every
 * redraw. Rows and the body are therefore never rebuilt while a turn
 * streams, which is what lets the row-enter and expand/collapse animations
 * run once instead of restarting on every token. All displayed content is
 * still derived from `TurnActivity` (see `turn-activity.ts`); the instance
 * only remembers the viewer's own choices (expanded rows and groups, "show
 * more") and in-flight button presses.
 *
 * Expansion: a group is expanded while it is active, forced open while it
 * waits for approval, and collapses to its one-line summary once done,
 * unless a call failed (the failure and its Retry stay visible) or the
 * viewer toggled it, in which case their choice is kept. A group
 * first rendered as done (a replayed or reloaded turn) starts collapsed
 * without animating.
 *
 * Accessibility: headers and row toggles are buttons with `aria-expanded`
 * and `aria-controls` (a row's toggle covers the whole row for pointer use,
 * while Retry and approval buttons sit above it as separate buttons);
 * collapsed content is `inert`; status is conveyed by a distinct icon plus
 * text ("Could not ...", "Denied", or screen-reader text for running and
 * completed rows), never by color alone; approval requests are announced
 * through a polite live region without moving focus.
 */
import { h } from "../dom.js";
import { icon, type IconName } from "../icons.js";
import {
  callDurationMs,
  displayStatus,
  formatDuration,
  summarizeGroup,
  type ToolCall,
  type ToolCallStatus,
  type ToolGroup,
} from "./turn-activity.js";
import { callDetails, defaultToolFormatters, toolCallContext, type ToolFormatterRegistry } from "./tool-formatters.js";

/** Output longer than this is shown truncated with "Show more". */
const PREVIEW_CHARS = 4_000;
const PREVIEW_LINES = 40;
/** Hard cap for "Show more", so a huge output cannot stall the renderer. */
const FULL_CHARS = 200_000;
/** Header icons shown before the stack is considered full. */
const MAX_HEADER_ICONS = 4;

export interface ToolGroupCardModel {
  /** The run these calls belong to; approval rows expose it for exact navigation. */
  readonly runId?: string;
  readonly group: ToolGroup;
  readonly calls: Readonly<Record<string, ToolCall>>;
  /** True while the host is executing the run. */
  readonly live: boolean;
  /** Approval IDs the host still lists as pending; only these show Allow/Deny. */
  readonly pendingApprovalIds: ReadonlySet<string>;
  /** Whether failed calls may offer Retry (the turn has finished and nothing else is running). */
  readonly canRetry: boolean;
  /** Renders a thinking entry of this group (shared with the transcript). */
  readonly renderThought: (index: number) => { readonly signature: string; readonly render: () => HTMLElement } | undefined;
}

export interface ToolGroupCardActions {
  /** Answers an approval through the host; resolves when the request settles. */
  readonly respond: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
  /** Asks the agent to retry a failed call in a new turn; see `Controller.runAgain`. */
  readonly retry?: (request: RetryRequest) => void;
}

/** What Retry tells the agent: the failed action and the error it reported. */
export interface RetryRequest {
  readonly action: string;
  readonly error?: string;
}

/**
 * The Orchestration panel's arc spinner. Its rotation is phase-locked to the
 * clock, so a spinner rebuilt by an update continues instead of restarting.
 */
function spinner(): HTMLElement {
  const node = h("span", { class: "tool-spinner", aria: { hidden: "true" } });
  node.style.animationDelay = `-${Math.round(performance.now() % 900)}ms`;
  return node;
}

let nextElementId = 0;
const elementId = (prefix: string) => `${prefix}-${++nextElementId}`;

export class ToolGroupCard {
  readonly element: HTMLElement;
  private readonly header: HTMLButtonElement;
  private readonly icons: HTMLElement;
  private readonly status: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly body: HTMLElement;
  private readonly rows: HTMLElement;
  private readonly announcer: HTMLElement;
  /** The "Working..." row; always the last child of `rows`, shown only when idle and active. */
  private readonly working: HTMLElement;
  private readonly rowViews = new Map<string, ToolRow>();
  private readonly thoughts = new Map<number, { signature: string; node: HTMLElement }>();
  /** The viewer's explicit expand/collapse choice, if any. */
  private userExpanded: boolean | undefined;
  private rendered = false;
  private iconSignature = "";
  private announced = new Set<string>();

  constructor(private readonly actions: ToolGroupCardActions, private readonly formatters: ToolFormatterRegistry = defaultToolFormatters) {
    const bodyId = elementId("tool-group-body");
    this.icons = h("span", { class: "tool-group-icons", aria: { hidden: "true" } });
    this.status = h("span", { class: "tool-group-status" });
    this.detail = h("span", { class: "tool-group-detail" });
    this.header = h("button", { class: "tool-group-header", type: "button", aria: { expanded: "false", controls: bodyId },
      onClick: () => { this.userExpanded = !this.isExpanded(); this.applyExpansion(this.currentPhase, this.hasFailures); } },
    this.icons, this.status, this.detail, icon("caret-down", { className: "tool-group-caret" }));
    this.working = h("div", { class: "tool-row tool-row-working", aria: { hidden: "true" } },
      h("div", { class: "tool-row-head" },
        h("span", { class: "tool-row-icon" }, spinner()),
        h("span", { class: "tool-row-text" }, h("span", { class: "tool-row-label tool-shimmer" }, "Working…"))));
    this.working.hidden = true;
    this.rows = h("div", { class: "tool-group-rows" }, this.working);
    this.body = h("div", { class: "tool-group-body", id: bodyId }, h("div", { class: "tool-group-clip" }, this.rows));
    this.announcer = h("div", { class: "sr-only", aria: { live: "polite" } });
    this.element = h("section", { class: "tool-group-card", aria: { label: "Tool activity" } }, this.header, this.body, this.announcer);
  }

  private currentPhase: "waiting" | "active" | "done" = "active";
  private hasFailures = false;

  update(model: ToolGroupCardModel): void {
    const summary = summarizeGroup(model.group, model.calls, model.live);
    this.currentPhase = summary.phase;
    this.element.dataset.phase = summary.phase;
    if (this.status.textContent !== summary.title) this.status.textContent = summary.title;
    if (this.detail.textContent !== (summary.detail ?? "")) this.detail.textContent = summary.detail ?? "";
    this.detail.classList.toggle("problem", summary.detailIsProblem);
    this.header.setAttribute("aria-label", summary.text);
    this.element.classList.toggle("has-problems", summary.failed > 0);
    this.hasFailures = summary.failed > 0;

    const calls = model.group.callIds.flatMap((id) => model.calls[id] === undefined ? [] : [model.calls[id]!]);
    const views = new Map(calls.map((call) => [call.id, this.describe(call, model)] as const));
    const iconNames = [...new Set([...views.values()].map((view) => view.icon))];
    const iconSignature = iconNames.slice(0, MAX_HEADER_ICONS).join(",") + (iconNames.length > MAX_HEADER_ICONS ? "+" : "");
    if (iconSignature !== this.iconSignature) {
      this.iconSignature = iconSignature;
      this.icons.replaceChildren(...iconNames.slice(0, MAX_HEADER_ICONS).map((name) => h("span", { class: "tool-group-icon", data: { icon: name } }, icon(name))));
    }

    // Entries only ever append, in order: new rows and thoughts go before the
    // "Working..." row. Rows arriving in the same update drop in staggered.
    let entering = 0;
    for (const entry of model.group.entries) {
      if (entry.kind === "call") {
        const view = views.get(entry.id);
        if (view === undefined) continue;
        let row = this.rowViews.get(entry.id);
        if (row === undefined) {
          // Rows of a live group fade in, including its first one; a group
          // first seen finished (a replay or reload) appears without motion.
          const animate = this.rendered || summary.phase !== "done";
          row = new ToolRow(this.actions, animate, model.runId);
          if (animate) row.element.style.setProperty("--enter-delay", `${Math.min(entering++, 8) * 55}ms`);
          this.rowViews.set(entry.id, row);
        }
        row.update(view);
        if (row.element.parentNode !== this.rows) this.rows.insertBefore(row.element, this.working);
        if (view.approval?.actionable === true && !this.announced.has(view.approval.id)) {
          this.announced.add(view.approval.id);
          this.announcer.textContent = `Approval needed: ${view.approval.action}`;
        }
      } else {
        const thought = model.renderThought(entry.index);
        if (thought === undefined) continue;
        const previous = this.thoughts.get(entry.index);
        if (previous?.signature === thought.signature && previous.node.parentNode === this.rows) continue;
        const node = h("div", { class: "tool-group-thought" }, thought.render());
        if (previous !== undefined && previous.node.parentNode === this.rows) previous.node.replaceWith(node);
        else this.rows.insertBefore(node, this.working);
        this.thoughts.set(entry.index, { signature: thought.signature, node });
      }
    }

    // Between calls the agent is still working; say so at the end of the rail.
    this.working.hidden = !(summary.phase === "active" && calls.every((call) => call.status !== "running" && call.status !== "awaiting_approval"));
    this.applyExpansion(summary.phase, this.hasFailures);
    if (!this.rendered) {
      this.rendered = true;
      // Enable transitions only after the first state is painted, so a turn
      // that is already finished appears collapsed instead of animating shut.
      requestAnimationFrame(() => this.element.classList.add("animated"));
    }
  }

  private isExpanded(): boolean {
    return this.header.getAttribute("aria-expanded") === "true";
  }

  private applyExpansion(phase: "waiting" | "active" | "done", hasFailures: boolean): void {
    const expanded = phase === "waiting" || (this.userExpanded ?? (phase !== "done" || hasFailures));
    this.header.setAttribute("aria-expanded", String(expanded));
    this.element.classList.toggle("expanded", expanded);
    // Collapsed rows stay in the DOM for the height animation but must not be
    // focusable or read out.
    this.body.inert = !expanded;
  }

  private describe(call: ToolCall, model: ToolGroupCardModel): RowView {
    const status = displayStatus(call, model.live);
    const context = toolCallContext({
      tool: call.tool, input: call.input, ...(call.mcp === undefined ? {} : { mcp: call.mcp }),
      ...(call.output === undefined ? {} : { output: call.output }), ...(call.progress === undefined ? {} : { progress: call.progress }),
      isError: status === "error", ...(call.approval?.request.reason === undefined ? {} : { reason: call.approval.request.reason }),
    });
    const format = this.formatters.resolve(context);
    const duration = status === "success" || status === "error" ? callDurationMs(call) : undefined;
    const approval = call.approval;
    const actionable = approval !== undefined && approval.state === "pending" && status === "awaiting_approval"
      && model.live && model.pendingApprovalIds.has(approval.request.id);
    // Calls that did not run read as the action; finished ones in the past
    // tense; failed ones as "Could not ..."; anything still going (or
    // stopped mid-way) in the present tense.
    const label = status === "awaiting_approval" || status === "denied" ? format.approval.action
      : status === "success" ? format.label("past") : status === "error" ? format.label("failed") : format.label("present");
    const outcome = STATUS_TEXT[status];
    const approvalNote = approval?.state === "allowed" && call.approvalOnly ? "Allowed"
      : approval?.state === "unanswered" ? "Not answered" : undefined;
    // A failure's error is its second line; the right side then holds only Retry.
    const failed = status === "error";
    return {
      id: call.id, icon: format.icon, label, status, statusText: outcome.label,
      ...(status === "success" && format.summary !== undefined ? { summary: format.summary } : {}),
      ...(failed && format.summary !== undefined ? { subtitle: format.summary } : {}),
      ...(failed && model.canRetry && this.actions.retry !== undefined ? { retry: {
        action: format.label("imperative"), ...(format.summary === undefined ? {} : { error: format.summary }) } } : {}),
      ...(approvalNote === undefined ? {} : { note: approvalNote }),
      ...(duration === undefined || failed ? {} : { duration: formatDuration(duration) }),
      ...(approval === undefined || approval.state !== "pending" || status !== "awaiting_approval" ? {} : { approval: {
        id: approval.request.id, action: format.approval.action,
        ...(format.approval.consequence === undefined ? {} : { consequence: format.approval.consequence }),
        actionable,
      } }),
      details: callDetails(context, call.input),
    };
  }
}

/** Icon and text for each status. `visible` statuses also show their text, so color is never the only signal. */
const STATUS_TEXT: Readonly<Record<ToolCallStatus, { readonly icon: IconName; readonly label: string; readonly visible: boolean }>> = {
  // Running uses the arc spinner rather than this icon (see renderSummary).
  running: { icon: "circle-notch", label: "Running", visible: false },
  awaiting_approval: { icon: "hand", label: "Waiting for approval", visible: false },
  success: { icon: "check-circle", label: "Completed", visible: false },
  // The "Could not ..." label already says it in words.
  error: { icon: "warning-circle", label: "Failed", visible: false },
  denied: { icon: "prohibit", label: "Denied", visible: true },
  interrupted: { icon: "stop-circle", label: "Stopped", visible: true },
  incomplete: { icon: "question", label: "No result", visible: true },
};

interface RowView {
  readonly id: string;
  readonly icon: IconName;
  readonly label: string;
  readonly status: ToolCallStatus;
  readonly statusText: string;
  readonly summary?: string;
  /** Second line under the label: a failure's error message. */
  readonly subtitle?: string;
  readonly retry?: RetryRequest;
  readonly note?: string;
  readonly duration?: string;
  readonly approval?: { readonly id: string; readonly action: string; readonly consequence?: string; readonly actionable: boolean };
  readonly details: readonly { readonly label: string; readonly text: string; readonly kind: "json" | "text" }[];
}

/** One call. Keeps its element (and the viewer's disclosure choices) across updates. */
class ToolRow {
  readonly element: HTMLElement;
  private readonly head: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly approvalSlot: HTMLElement;
  private readonly details: HTMLElement;
  private signature = "";
  private detailsSignature = "";
  private expanded = false;
  private readonly fullSections = new Set<string>();
  private submitting: "allow" | "deny" | undefined;
  private view: RowView | undefined;
  private approvalBlock: { readonly id: string; readonly group: HTMLElement; readonly consequence: HTMLElement; readonly deny: HTMLButtonElement; readonly allow: HTMLButtonElement } | undefined;

  constructor(private readonly actions: ToolGroupCardActions, animateEntry: boolean, private readonly runId?: string) {
    const detailsId = elementId("tool-row-details");
    // The toggle wraps only the label; its ::after stretches over the whole
    // row so a click anywhere expands it, while Retry stays a separate button.
    this.toggle = h("button", { class: "tool-row-toggle", type: "button", aria: { expanded: "false", controls: detailsId },
      onClick: () => this.setExpanded(!this.expanded) });
    this.head = h("div", { class: "tool-row-head" });
    this.approvalSlot = h("div", { class: "tool-row-approval-slot" });
    this.details = h("div", { class: "tool-row-details", id: detailsId });
    this.details.hidden = true;
    this.element = h("div", { class: animateEntry ? "tool-row entering" : "tool-row" }, this.head, this.approvalSlot, this.details);
    if (animateEntry) {
      // Remove the entry animation once it ran, so moving or restyling the
      // row later can never replay it.
      this.element.addEventListener("animationend", () => this.element.classList.remove("entering"), { once: true });
    }
  }

  update(view: RowView): void {
    this.view = view;
    const signature = JSON.stringify([view.icon, view.label, view.status, view.summary, view.subtitle, view.retry, view.note, view.duration, view.approval, this.submitting]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.renderSummary(view);
    }
    if (this.expanded) this.renderDetails(view);
  }

  private renderSummary(view: RowView): void {
    const outcome = STATUS_TEXT[view.status];
    this.element.dataset.status = view.status;
    this.element.classList.toggle("needs-approval", view.approval !== undefined);
    this.element.classList.toggle("has-subtitle", view.subtitle !== undefined);
    const meta: Node[] = [];
    if (view.summary !== undefined) meta.push(h("span", { class: "tool-row-summary" }, view.summary));
    if (view.note !== undefined) meta.push(h("span", { class: "tool-row-summary" }, view.note));
    if (outcome.visible) meta.push(h("span", { class: "tool-row-outcome" }, outcome.label));
    if (view.duration !== undefined) meta.push(h("span", { class: "tool-row-duration" }, view.duration));
    const retry = view.retry;
    this.toggle.replaceChildren(h("span", { class: "tool-row-label", title: view.label }, view.label));
    this.head.replaceChildren(
      h("span", { class: "tool-row-icon", aria: { hidden: "true" }, data: { icon: view.icon } }, icon(view.icon)),
      h("span", { class: "tool-row-text" }, this.toggle,
        view.subtitle === undefined ? null : h("span", { class: "tool-row-subtitle", title: view.subtitle }, view.subtitle)),
      // The toggle's accessible name carries the same facts as these marks.
      h("span", { class: "tool-row-meta", aria: { hidden: "true" } }, ...meta),
      ...(retry === undefined ? [] : [h("button", { class: "tool-row-retry", type: "button", aria: { label: `Retry: ${retry.action}` },
        onClick: () => this.actions.retry?.(retry) }, icon("arrow-counter-clockwise"), "Retry")]),
      h("span", { class: `tool-row-status status-${view.status}`, aria: { hidden: "true" } },
        view.status === "running" ? spinner() : icon(outcome.icon)),
      icon("caret-down", { className: "tool-row-caret" }),
    );
    this.toggle.setAttribute("aria-label", [view.label, view.subtitle, view.summary, view.note, outcome.label, view.duration].filter(Boolean).join(", "));
    this.renderApproval(view);
  }

  /**
   * The approval block is built once per approval and then only updated, so
   * a keyboard user who presses Allow keeps focus on that button while the
   * request is in flight. When the decision lands and the block goes away,
   * focus moves to the row itself rather than being dropped on the page.
   */
  private renderApproval(view: RowView): void {
    const approval = view.approval;
    if (approval === undefined) {
      if (this.approvalBlock !== undefined) {
        const hadFocus = this.approvalSlot.contains(document.activeElement);
        this.approvalSlot.replaceChildren();
        this.approvalBlock = undefined;
        if (hadFocus) this.toggle.focus();
      }
      return;
    }
    if (this.approvalBlock?.id !== approval.id) {
      const consequence = h("span", { class: "tool-approval-consequence" });
      const deny = h("button", { class: "button button-small", type: "button", onClick: () => this.answer(approval.id, "deny") }, "Deny");
      const allow = h("button", { class: "button button-small button-primary", type: "button", onClick: () => this.answer(approval.id, "allow") }, "Allow");
      const info = h("button", { class: "icon-button tool-approval-info", type: "button",
        aria: { label: "Show request details", expanded: String(this.expanded), controls: this.details.id },
        onClick: () => this.setExpanded(!this.expanded) }, icon("info"));
      // Focusable as a target for the composer's "Review" pointer; the
      // pending-request/execution pair is what the orchestration panel's
      // Review action looks up for worker approvals.
      const group = h("div", { class: "tool-approval", role: "group", data: { approvalId: approval.id, pendingRequest: approval.id,
        ...(this.runId === undefined ? {} : { executionId: this.runId }) } },
        h("div", { class: "tool-approval-text" }, consequence),
        h("div", { class: "tool-approval-actions" }, info, deny, allow));
      group.tabIndex = -1;
      this.approvalSlot.replaceChildren(group);
      this.approvalBlock = { id: approval.id, group, consequence, deny, allow };
    }
    const block = this.approvalBlock;
    block.group.setAttribute("aria-label", `Approval required: ${approval.action}`);
    block.consequence.textContent = approval.consequence ?? "";
    block.consequence.hidden = approval.consequence === undefined;
    // Buttons stay visible but inert until the host lists the approval as
    // pending (and while an answer is in flight), so they never flicker.
    const busy = this.submitting !== undefined;
    block.deny.disabled = !approval.actionable || busy;
    block.allow.disabled = !approval.actionable || busy;
    block.deny.setAttribute("aria-busy", String(this.submitting === "deny"));
    block.allow.setAttribute("aria-busy", String(this.submitting === "allow"));
    block.deny.textContent = this.submitting === "deny" ? "Denying" : "Deny";
    block.allow.textContent = this.submitting === "allow" ? "Allowing" : "Allow";
  }

  private answer(approvalId: string, decision: "allow" | "deny"): void {
    if (this.submitting !== undefined || this.view?.approval?.actionable !== true) return;
    this.submitting = decision;
    this.update(this.view);
    void this.actions.respond(approvalId, decision).finally(() => {
      // On success the host's resolution event removes the buttons; on
      // failure (answered elsewhere, host gone) they become usable again.
      this.submitting = undefined;
      if (this.view !== undefined) this.update(this.view);
    });
  }

  private setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.toggle.setAttribute("aria-expanded", String(expanded));
    this.approvalSlot.querySelector(".tool-approval-info")?.setAttribute("aria-expanded", String(expanded));
    this.element.classList.toggle("expanded", expanded);
    this.details.hidden = !expanded;
    if (expanded && this.view !== undefined) this.renderDetails(this.view);
  }

  /** Raw details are built only while open, and only when they changed. */
  private renderDetails(view: RowView): void {
    const signature = JSON.stringify([view.details, [...this.fullSections]]);
    if (signature === this.detailsSignature) return;
    this.detailsSignature = signature;
    this.details.replaceChildren(...view.details.map((section) => {
      const full = this.fullSections.has(section.label);
      const lines = section.text.split("\n");
      const long = section.text.length > PREVIEW_CHARS || lines.length > PREVIEW_LINES;
      const shown = !long ? section.text
        : full ? section.text.slice(0, FULL_CHARS)
        : lines.slice(0, PREVIEW_LINES).join("\n").slice(0, PREVIEW_CHARS);
      const capped = full && section.text.length > FULL_CHARS;
      return h("section", { class: "tool-row-section" },
        h("span", { class: "tool-row-section-label" }, section.label),
        h("pre", { class: `tool-row-pre tool-row-${section.kind}` }, shown),
        !long ? null : h("button", { class: "tool-row-more", type: "button", aria: { expanded: String(full) }, onClick: () => {
          if (full) this.fullSections.delete(section.label); else this.fullSections.add(section.label);
          this.renderDetails(view);
        } }, full ? "Show less" : `Show more (${lines.length.toLocaleString()} lines, ${formatSize(section.text.length)})`),
        capped ? h("span", { class: "tool-row-capped" }, `Showing the first ${formatSize(FULL_CHARS)}. Open the run details for the complete journal.`) : null);
    }));
  }
}

function formatSize(characters: number): string {
  return characters < 1024 ? `${characters} characters` : `${Math.round(characters / 1024).toLocaleString()} KB`;
}
