/** Shared, tabbed review surface for the account inbox and local repository workflows. */
import type { CodeHost, PullDetail, ReviewAction } from "../../../features/pull-requests/index.js";
import { h, replace, relativeTime } from "../dom.js";
import { icon } from "../icons.js";
import { createDropdown } from "../components/dropdown.js";
import { diffFiles, diffRows } from "./change-diff.js";
export type ReviewTab = "overview" | "code" | "activity";
interface Options {
  detail: PullDetail; provider: CodeHost; authenticated: boolean; busy: boolean;
  repository: string; draft: string; decision: ReviewAction; tab: ReviewTab; account?: HTMLElement;
  onDraft(value: string): void; onDecision(value: ReviewAction): void; onTab(tab: ReviewTab): void; onBack(): void;
  onReview(action: ReviewAction, body: string): void;
  onState(action: "merge" | "close" | "reopen"): void;
  onTimeline(): void; onRefresh(): void;
}
export function renderReviewDetail(root: HTMLElement, options: Options): void {
  const { detail, provider, authenticated, busy } = options, { pull } = detail;
  const button = (title: string, action: () => void, primary = false) => h("button", { type: "button", class: `button button-small${primary ? " button-primary" : ""}`, onClick: action }, title);
  const timeline = button("View in Timeline", options.onTimeline); timeline.disabled = busy;
  const refresh = button("Refresh review", options.onRefresh); refresh.disabled = busy;
  const canReview = authenticated && pull.state === "open" && !busy;
  const tabs: readonly [ReviewTab, string][] = [["overview", "Overview"], ["code", "Code"], ["activity", "Activity"]];
  const content = h("div", { class: `pr-tab-content pr-tab-${options.tab}` });
  if (options.tab === "overview") {
    const text = h("textarea", { rows: 4, placeholder: "Leave a review…", aria: { label: "Review comment" }, value: options.draft, onInput: () => options.onDraft(text.value) });
    const decision = createDropdown<ReviewAction>({ ariaLabel: "Review decision", variant: "pill", onChange: options.onDecision });
    decision.setOptions([{ value: "comment", label: "Comment" }, { value: "approve", label: "Approve" },
      { value: "request_changes", label: "Request changes", disabled: provider === "gitlab", description: provider === "gitlab" ? "Use a comment or GitLab's review controls" : "Ask for an update" }], options.decision);
    decision.setDisabled(!canReview); text.disabled = busy;
    const submit = button("Submit review", () => options.onReview(decision.value ?? "comment", text.value), true); submit.disabled = !canReview;
    const merge = button("Merge pull request", () => options.onState("merge")); merge.disabled = !canReview || pull.draft;
    const close = button(pull.state === "closed" ? "Reopen" : "Close pull request", () => options.onState(pull.state === "closed" ? "reopen" : "close"));
    close.disabled = !authenticated || busy || pull.state === "merged" || (pull.state === "closed" && provider === "bitbucket");
    content.append(h("div", { class: "review-description" }, pull.body || "No description provided."),
      h("section", { class: "pr-checks" }, h("h3", {}, `Checks${detail.checks.length ? ` · ${detail.checks.length}` : ""}`),
        ...detail.checks.map((check) => h("div", { class: "review-check" }, h("span", {}, check.name), h("span", { class: "mono" }, check.status),
          check.url.startsWith("https://") ? button("Open check", () => window.open(check.url, "_blank", "noopener")) : null)),
        h("p", { class: "note" }, detail.checksNotice ?? (detail.checks.length ? "Repository rules are enforced by the code host." : "No checks reported."))),
      h("section", { class: "review-compose" }, h("h3", {}, "Your review"), text,
        !authenticated ? h("p", { class: "note" }, "Connect an account to submit a review.") : null,
        h("div", { class: "page-actions" }, decision.element, submit), h("div", { class: "review-merge-actions" }, merge, close)));
  } else if (options.tab === "code") {
    const files = diffFiles(detail.diff), patch = h("div", { class: "review-file-list", aria: { label: "Pull request files" } });
    const fileSearch = h("input", { class: "pr-file-search", type: "search", placeholder: "Find a file…", aria: { label: "Find a changed file" }, onInput: () => {
      patch.querySelectorAll<HTMLElement>(".review-file").forEach((file) => { file.hidden = !file.dataset.file?.toLowerCase().includes(fileSearch.value.toLowerCase()); });
    } });
    let renderedRows = 0;
    for (const file of files.slice(0, 200)) {
      const code = h("pre", { class: "review-patch" }), lines = diffRows(file.lines.join("\n"));
      for (const row of lines.slice(0, Math.max(0, 5000 - renderedRows))) {
        code.append(h("div", { class: `review-diff-line ${row.kind}` }, h("span", { class: "review-line-number" }, String(row.oldLine ?? "")), h("span", { class: "review-line-number" }, String(row.newLine ?? "")), `${row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "} ${row.text || " "}`)); renderedRows++;
      }
      if (!lines.length) code.append("Binary or renamed file. See Timeline for exact contents.");
      patch.append(h("details", { class: "review-file", open: files.length < 6, data: { file: file.title } }, h("summary", {}, file.title, h("span", { class: "note" }, ` +${file.added} −${file.removed}`)), code));
    }
    content.append(h("div", { class: "pr-code-toolbar" }, h("span", { class: "note" }, `${files.length} changed files`), fileSearch), patch);
    if (!detail.diff) content.append(h("p", { class: "page-empty" }, "No text diff available. Open the code host to inspect binary changes."));
    if (diffRows(detail.diff).length > 5000 || files.length > 200) content.append(h("p", { class: "note" }, "The diff is shortened. Open the code host for all changes."));
  } else {
    content.append(h("section", { class: "review-discussion" }, ...detail.comments.map((comment) => h("article", { class: "review-comment" }, h("div", { class: "note" }, `${comment.author} · ${relativeTime(comment.createdAt)}`), h("div", {}, comment.body))),
      detail.comments.length ? null : h("p", { class: "page-empty" }, "No discussion yet.")));
  }
  replace(root,
    h("div", { class: "pr-detail-navigation" }, button("Back to pull requests", options.onBack), options.account),
    h("header", { class: "pr-detail-heading" }, h("p", { class: "pr-repository note" }, `${options.repository} #${pull.id}`),
      h("h2", {}, pull.title), h("div", { class: "pr-detail-meta" }, h("span", { class: `review-state ${pull.state}` }, pull.draft ? "Draft" : pull.state),
        h("span", {}, `${pull.author} · ${pull.source} → ${pull.target}`)),
      h("div", { class: "review-detail-actions" }, timeline, refresh, button("Open on code host", () => { if (pull.url.startsWith("https://")) window.open(pull.url, "_blank", "noopener"); }))),
    detail.timelineError ? h("p", { class: "error-line", role: "alert" }, detail.timelineError) : detail.timelineCheckpointId ? h("p", { class: "note" }, "Synced to Timeline · refreshes with this PR") : null,
    detail.truncated ? h("p", { class: "note" }, "Discussion or diff is shortened. Open the code host for the complete review.") : null,
    h("nav", { class: "pr-detail-tabs", aria: { label: "Review sections" } }, ...tabs.map(([tab, title]) => h("button", { type: "button", class: tab === options.tab ? "active" : "", aria: { pressed: String(tab === options.tab) }, onClick: () => options.onTab(tab) }, tab === "code" ? icon("git-branch") : null, title))), content);
}
