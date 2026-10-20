/**
 * Shared, tabbed review surface for the account inbox and local repository workflows.
 *
 * The caller owns state (selected tab, review draft, decision, busy flag) and
 * re-renders on change; this module only builds DOM from `Options`.
 *
 * - Overview: the PR description (Markdown), CI checks as icon plus word, the
 *   review composer, and merge/close/reopen.
 * - Code: changed files as collapsible unified diffs, styled like Changes.
 * - Activity: conversation comments, submitted reviews and inline comments.
 *
 * Provider text is rendered through `renderMarkdown`, which builds text nodes
 * only, so PR bodies and comments cannot inject markup. Links open through
 * `openLink` (the default browser).
 */
import type { CodeHost, PullDetail, ReviewAction, ReviewComment, ReviewFile } from "../../../features/pull-requests/index.js";
import { h, replace, relativeTime } from "../dom.js";
import { icon, type IconName } from "../icons.js";
import { createDropdown } from "../components/dropdown.js";
import { renderMarkdown } from "../markdown.js";
import { diffFiles, diffRows } from "./change-diff.js";
import { bindContentMenu } from "../components/context-menu.js";
import { selectionQuestion } from "./side-chat-prompt.js";

export type ReviewTab = "overview" | "code" | "activity";
interface Options {
  detail: PullDetail; provider: CodeHost; authenticated: boolean; busy: boolean;
  repository: string; draft: string; decision: ReviewAction; tab: ReviewTab; account?: HTMLElement;
  onDraft(value: string): void; onDecision(value: ReviewAction): void; onTab(tab: ReviewTab): void; onBack(): void;
  onReview(action: ReviewAction, body: string): void;
  onState(action: "merge" | "close" | "reopen"): void;
  onTimeline(): void; onRefresh(): void;
  /** Opens the side chat and asks the selected model to explain the PR. */
  onExplain(): void;
  /** Shows or hides the side chat docked beside the review. */
  onSideChat(): void;
  /** Opens the dock, optionally appending a selected-text question without sending. */
  onOpenSideChat(draft?: string): void;
  sideChatOpen: boolean;
  /** Opens an http(s) link outside the app. */
  openLink(href: string): void;
}

/** Rendering limits keep very large PRs responsive; the code host has the rest. */
const MAX_FILES = 200, MAX_ROWS = 5000;

/** Provider check vocabularies differ; the UI shows four outcomes, each an icon plus a word. */
type CheckOutcome = "passed" | "failed" | "running" | "skipped";
const CHECK_OUTCOMES: Readonly<Record<CheckOutcome, { label: string; icon: IconName }>> = {
  passed: { label: "Passed", icon: "check-circle" },
  failed: { label: "Failed", icon: "x-circle" },
  running: { label: "In progress", icon: "circle-dashed" },
  skipped: { label: "Skipped", icon: "minus-circle" },
};
export function checkOutcome(status: string): CheckOutcome {
  const value = status.toLowerCase();
  if (["success", "successful", "passed", "completed"].includes(value)) return "passed";
  if (["failure", "failed", "error", "timed_out", "action_required", "startup_failure", "stopped"].includes(value)) return "failed";
  if (["cancelled", "canceled", "skipped", "neutral", "stale", "manual"].includes(value)) return "skipped";
  return "running";
}

const STATE_LABELS = { open: "Open", merged: "Merged", closed: "Closed" } as const;
const STATE_ICONS: Readonly<Record<keyof typeof STATE_LABELS, IconName>> = { open: "git-pull-request", merged: "git-merge", closed: "x-circle" };

const FILE_ICONS: Readonly<Record<ReviewFile["status"], IconName>> = { added: "file-plus", removed: "file-minus", renamed: "arrow-right", modified: "file-text" };

/** Per-file changes from the host, or files parsed from a unified diff (Bitbucket). */
function reviewFiles(detail: PullDetail): readonly ReviewFile[] {
  return detail.files ?? diffFiles(detail.diff).map((file) => ({ path: file.title, status: "modified" as const, additions: file.added, deletions: file.removed, patch: file.lines.join("\n") }));
}

/** Long descriptions start collapsed; expanded PRs (by URL) stay expanded across re-renders. */
const LONG_DESCRIPTION = 1200;
const expandedDescriptions = new Set<string>();

/** PR templates often carry HTML comments; they are instructions to authors, not content. */
const stripHtmlComments = (text: string) => text.replace(/<!--[\s\S]*?-->/g, "").trim();

export function renderReviewDetail(root: HTMLElement, options: Options): void {
  const { detail, provider, authenticated, busy } = options, { pull } = detail;
  bindContentMenu(root, ({ selection }) => [
    { label: "Open side chat", icon: "chat-circle-text", run: () => options.onOpenSideChat() },
    ...(selection ? [{ label: "Ask about selection", icon: "sparkle" as const, run: () => options.onOpenSideChat(selectionQuestion(selection)) }] : []),
    { label: "Explain with AI", icon: "sparkle", run: options.onExplain },
    null,
    { label: "Open in Timeline", icon: "clock-counter-clockwise", disabled: busy, run: options.onTimeline },
    { label: "Open on code host", icon: "arrow-up-right", run: () => options.openLink(pull.url) },
    { label: "Copy PR link", icon: "copy", run: () => navigator.clipboard.writeText(pull.url) },
  ]);
  const iconButton = (title: string, name: IconName, action: () => void) =>
    h("button", { type: "button", class: "icon-button", title, aria: { label: title }, onClick: action }, icon(name));
  const labeledButton = (title: string, name: IconName, action: () => void, primary = false) =>
    h("button", { type: "button", class: `button button-small pr-action${primary ? " button-primary" : ""}`, onClick: action }, icon(name), h("span", {}, title));
  const openExternal = (url: string) => { if (url.startsWith("https://")) options.openLink(url); };
  const markdown = (text: string) => h("div", { class: "md pr-markdown" }, renderMarkdown(text, (href) => openExternal(href)));

  const timeline = labeledButton("Open in Timeline", "clock-counter-clockwise", options.onTimeline); timeline.disabled = busy;
  timeline.title = "Compare the complete PR in Timeline. Uses a local checkout of this repository.";
  const explain = labeledButton("Explain with AI", "sparkle", options.onExplain, true);
  explain.title = "Ask the selected model to explain these changes in the side chat (read-only).";
  const side = iconButton(options.sideChatOpen ? "Hide side chat" : "Side chat", "chat-circle-text", options.onSideChat);
  side.classList.toggle("active", options.sideChatOpen); side.setAttribute("aria-pressed", String(options.sideChatOpen));
  const refresh = iconButton("Refresh review", "arrow-clockwise", options.onRefresh); refresh.disabled = busy;
  const files = reviewFiles(detail);
  const canReview = authenticated && pull.state === "open" && !busy;
  const tabs: readonly [ReviewTab, string, IconName, number | undefined][] = [
    ["overview", "Overview", "file-text", undefined],
    ["code", "Code", "git-diff", files.length],
    ["activity", "Activity", "chat-circle-text", detail.comments.length]];
  const content = h("div", { class: `pr-tab-content pr-tab-${options.tab}` });

  if (options.tab === "overview") {
    const description = stripHtmlComments(pull.body);
    const text = h("textarea", { rows: 4, placeholder: "Leave a review…", aria: { label: "Review comment" }, value: options.draft, onInput: () => options.onDraft(text.value) });
    const decision = createDropdown<ReviewAction>({ ariaLabel: "Review decision", variant: "pill", onChange: options.onDecision });
    decision.setOptions([{ value: "comment", label: "Comment", icon: "chat-circle-text" }, { value: "approve", label: "Approve", icon: "check-circle" },
      { value: "request_changes", label: "Request changes", icon: "warning-circle", disabled: provider === "gitlab", description: provider === "gitlab" ? "Use a comment or GitLab's review controls" : "Ask for an update" }], options.decision);
    decision.setDisabled(!canReview); text.disabled = busy || !authenticated;
    const submit = labeledButton("Submit review", "paper-plane-right", () => options.onReview(decision.value ?? "comment", text.value), true); submit.disabled = !canReview;
    const merge = labeledButton("Merge", "git-merge", () => options.onState("merge")); merge.disabled = !canReview || pull.draft;
    if (pull.draft) merge.title = "Draft pull requests cannot be merged";
    const reopening = pull.state === "closed";
    const close = labeledButton(reopening ? "Reopen" : "Close", reopening ? "arrow-counter-clockwise" : "x-circle", () => options.onState(reopening ? "reopen" : "close"));
    close.disabled = !authenticated || busy || pull.state === "merged" || (reopening && provider === "bitbucket");
    const outcomes = detail.checks.map((check) => checkOutcome(check.status));
    const summary = (["failed", "running", "passed", "skipped"] as const).map((outcome) => [outcome, outcomes.filter((value) => value === outcome).length] as const)
      .filter(([, count]) => count > 0).map(([outcome, count]) => `${count} ${CHECK_OUTCOMES[outcome].label.toLowerCase()}`).join(" · ");
    content.append(
      describe(description, pull.url, markdown),
      h("section", { class: "pr-card pr-checks" },
        h("div", { class: "pr-card-heading" }, h("h3", {}, "Checks"), summary ? h("span", { class: "note" }, summary) : null),
        ...detail.checks.map((check, index) => {
          const outcome = CHECK_OUTCOMES[outcomes[index]!];
          return h("div", { class: `review-check check-${outcomes[index]}` },
            h("span", { class: "review-check-status", title: check.status }, icon(outcome.icon), h("span", {}, outcome.label)),
            h("span", { class: "review-check-name" }, check.name),
            check.url.startsWith("https://") ? iconButton(`Open ${check.name}`, "arrow-up-right", () => openExternal(check.url)) : null);
        }),
        detail.checksNotice || !detail.checks.length ? h("p", { class: "note" }, detail.checksNotice ?? "No checks reported.") : null),
      h("section", { class: "pr-card review-compose" }, h("h3", {}, "Your review"), text,
        !authenticated ? h("p", { class: "note" }, "Sign in to an account to submit a review.") : pull.state !== "open" ? h("p", { class: "note" }, `This pull request is ${STATE_LABELS[pull.state].toLowerCase()}.`) : null,
        h("div", { class: "review-compose-actions" }, decision.element, submit),
        h("div", { class: "review-merge-actions" }, merge, close)));
  } else if (options.tab === "code") {
    const list = h("div", { class: "review-file-list", aria: { label: "Pull request files" } });
    const added = files.reduce((sum, file) => sum + file.additions, 0), removed = files.reduce((sum, file) => sum + file.deletions, 0);
    const search = h("input", { class: "pr-file-search", type: "search", placeholder: "Find a file…", aria: { label: "Find a changed file" }, onInput: () => {
      const needle = search.value.toLowerCase();
      list.querySelectorAll<HTMLElement>(".review-file").forEach((file) => { file.hidden = !file.dataset.file?.toLowerCase().includes(needle); });
    } });
    let renderedRows = 0, shortened = files.length > MAX_FILES;
    for (const file of files.slice(0, MAX_FILES)) {
      const rows = file.patch ? diffRows(file.patch) : [], budget = Math.max(0, MAX_ROWS - renderedRows);
      if (rows.length > budget) shortened = true;
      const body = h("div", { class: "git-diff-scroll pr-file-diff" });
      for (const row of rows.slice(0, budget)) {
        body.append(row.kind === "hunk" || row.kind === "meta" ? h("div", { class: "git-diff-hunk" }, row.text)
          : h("div", { class: `git-diff-line ${row.kind}` }, h("span", { class: "git-line-number" }, row.oldLine ?? ""), h("span", { class: "git-line-number" }, row.newLine ?? ""),
            h("span", { class: "git-line-sign" }, row.kind === "added" ? "+" : row.kind === "removed" ? "−" : ""), h("span", { class: "git-line-text" }, row.text)));
        renderedRows++;
      }
      if (!rows.length) body.append(h("p", { class: "note pr-file-empty" }, file.patch === undefined && file.additions + file.deletions > 0
        ? "This file is too large or binary to show here. Open the code host to review it."
        : file.status === "renamed" ? `Renamed from ${file.previousPath ?? "another path"} without content changes.` : "No line changes."));
      const label = file.previousPath && file.status === "renamed" ? `${file.previousPath} → ${file.path}` : file.path;
      list.append(h("details", { class: `review-file file-${file.status}`, open: files.length < 6 && rows.length > 0, data: { file: label } },
        h("summary", {}, icon("caret-right", { className: "review-file-caret" }), h("span", { class: "review-file-status", title: file.status[0]!.toUpperCase() + file.status.slice(1) }, icon(FILE_ICONS[file.status])),
          h("span", { class: "review-file-name", title: label }, label),
          h("span", { class: "review-file-stats" }, h("span", { class: "added" }, `+${file.additions}`), h("span", { class: "removed" }, `−${file.deletions}`))), body));
    }
    content.append(h("div", { class: "pr-code-toolbar" },
      h("span", { class: "review-file-stats" }, h("span", {}, `${files.length} file${files.length === 1 ? "" : "s"}`), h("span", { class: "added" }, `+${added}`), h("span", { class: "removed" }, `−${removed}`)),
      h("label", { class: "pr-file-search-field" }, icon("magnifying-glass"), search)), list);
    if (!files.length) content.append(h("div", { class: "pr-inbox-empty" }, icon("git-diff"), h("p", {}, detail.truncated ? "This diff is too large to show here. Open the code host to review it." : "No changes to show.")));
    if (shortened || (detail.truncated && files.length)) content.append(h("p", { class: "note pr-shortened" }, icon("info"), h("span", {}, "Some changes are not shown because the diff is large. Open the code host for all changes.")));
  } else {
    content.append(h("section", { class: "review-discussion" }, ...detail.comments.map((comment) => renderComment(comment, markdown)),
      detail.comments.length ? null : h("div", { class: "pr-inbox-empty" }, icon("chat-circle-text"), h("p", {}, "No discussion yet."))));
  }

  const state = pull.draft && pull.state === "open" ? { label: "Draft", icon: "circle-dashed" as IconName, tone: "draft" } : { label: STATE_LABELS[pull.state], icon: STATE_ICONS[pull.state], tone: pull.state };
  replace(root,
    h("div", { class: "pr-detail-navigation" }, iconButton("Back to pull requests", "arrow-left", options.onBack), options.account ?? null),
    h("header", { class: "pr-detail-heading" },
      h("div", { class: "pr-detail-title-row" },
        h("div", { class: "pr-detail-title" }, h("p", { class: "pr-repository note" }, `${options.repository} #${pull.id}`), h("h2", {}, pull.title)),
        h("div", { class: "review-detail-actions" }, side, refresh, iconButton("Open on code host", "arrow-up-right", () => openExternal(pull.url)))),
      h("div", { class: "pr-detail-meta" }, h("span", { class: `pr-state-badge ${state.tone}` }, icon(state.icon), state.label),
        h("span", {}, h("strong", {}, pull.author), " wants to merge "), h("code", { class: "pr-branch" }, pull.source), icon("arrow-right"), h("code", { class: "pr-branch" }, pull.target)),
      h("div", { class: "pr-primary-actions" }, explain, timeline)),
    detail.timelineError ? h("p", { class: "error-line", role: "alert" }, icon("warning-circle"), h("span", {}, detail.timelineError))
      : detail.timelineCheckpointId ? h("p", { class: "note pr-synced" }, icon("check-circle"), h("span", {}, "Synced to Timeline · refreshes with this PR")) : null,
    detail.truncated && options.tab !== "code" ? h("p", { class: "note pr-shortened" }, icon("info"), h("span", {}, "Discussion or diff is shortened. Open the code host for the complete review.")) : null,
    h("nav", { class: "pr-detail-tabs", aria: { label: "Review sections" } }, ...tabs.map(([tab, title, name, count]) =>
      h("button", { type: "button", class: tab === options.tab ? "active" : "", aria: { pressed: String(tab === options.tab) }, onClick: () => options.onTab(tab) },
        icon(name), title, count !== undefined && count > 0 ? h("span", { class: "pr-tab-count" }, String(count)) : null))),
    content);
}

/** One Activity entry: who, what kind of contribution, when, and the Markdown body. */
function renderComment(comment: ReviewComment, markdown: (text: string) => HTMLElement): HTMLElement {
  const body = stripHtmlComments(comment.body);
  const kind: { icon: IconName; verb: string; tone: string } =
    comment.state === "approved" ? { icon: "check-circle", verb: "approved", tone: "approved" }
      : comment.state === "changes_requested" ? { icon: "warning-circle", verb: "requested changes", tone: "changes" }
        : comment.state === "dismissed" ? { icon: "minus-circle", verb: "review dismissed", tone: "dismissed" }
          : comment.kind === "review" ? { icon: "chat-circle-text", verb: "reviewed", tone: "comment" }
            : comment.kind === "inline" ? { icon: "code", verb: "commented on", tone: "comment" }
              : { icon: "chat-circle-text", verb: "commented", tone: "comment" };
  return h("article", { class: `review-comment ${kind.tone}` },
    h("div", { class: "review-comment-heading" }, h("span", { class: "review-comment-icon" }, icon(kind.icon)),
      h("strong", {}, comment.author || "Unknown"), h("span", { class: "note" }, kind.verb),
      comment.path ? h("code", { class: "pr-branch", title: comment.path }, comment.line ? `${comment.path}:${comment.line}` : comment.path) : null,
      comment.createdAt ? h("time", { class: "note", title: comment.createdAt }, relativeTime(comment.createdAt)) : null),
    body ? markdown(body) : null);
}

/** The description card; a long body is clipped with a toggle instead of a nested scroll area. */
function describe(description: string, key: string, markdown: (text: string) => HTMLElement): HTMLElement {
  const card = h("section", { class: "pr-card pr-description" });
  if (!description) { card.append(h("p", { class: "note" }, "No description provided.")); return card; }
  card.append(markdown(description));
  if (description.length <= LONG_DESCRIPTION) return card;
  const render = () => {
    const expanded = expandedDescriptions.has(key);
    card.classList.toggle("collapsed", !expanded);
    toggle.replaceChildren(icon(expanded ? "caret-up-down" : "caret-down"), h("span", {}, expanded ? "Show less" : "Show full description"));
    toggle.setAttribute("aria-expanded", String(expanded));
  };
  const toggle = h("button", { class: "button button-small pr-action pr-description-toggle", type: "button", onClick: () => {
    if (expandedDescriptions.has(key)) expandedDescriptions.delete(key); else expandedDescriptions.add(key);
    render();
  } });
  card.append(toggle);
  render();
  return card;
}
