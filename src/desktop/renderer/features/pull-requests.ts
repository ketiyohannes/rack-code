/** Unified GitHub inbox. Search/pagination and detail reads have independent stale-reply guards. */
import type { InboxDetail, InboxPull, InboxTarget, Involvement, ReviewAccount } from "../../../features/pull-requests/index.js";
import type { PullState, ReviewAction } from "../../../features/pull-requests/index.js";
import type { Controller } from "../controller.js";
import type { HostClient } from "../host-client.js";
import type { Store } from "../store.js";
import { h, replace, relativeTime } from "../dom.js";
import { icon, type IconName } from "../icons.js";
import { openModal } from "../components/modal.js";
import { openGitHubSignIn } from "../components/github-sign-in.js";
import { createSideChat } from "./side-chat.js";
import { createSideChatVisibility } from "./side-chat-state.js";
import { EXPLAIN_PROMPT, pullRequestSideChatContext } from "./side-chat-contexts.js";
import { createDropdown } from "../components/dropdown.js";
import { mountRepositoryPullRequests } from "./repository-reviews.js";
import { renderReviewDetail, type ReviewTab } from "./review-detail.js";
const key = (pull: InboxPull) => `${pull.host}/${pull.repository.toLowerCase()}#${pull.id}`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function mountPullRequests(root: HTMLElement, store: Store, controller: Controller, host: HostClient): void {
  let accounts: readonly ReviewAccount[] = [], pulls: InboxPull[] = [], selected: InboxPull | undefined;
  let target: InboxTarget | undefined, detail: InboxDetail | undefined, tab: ReviewTab = "overview";
  let involvement: Involvement = "involved", state: PullState = "open", accountId = "", page = 1;
  let queryGeneration = 0, detailGeneration = 0, accountGeneration = 0;
  // `accountsKnown` stays false until the first discovery settles, so the sign-in
  // prompt is never shown while existing gh logins are still being read.
  let accountsKnown = false;
  let loading = false, busy = false, hasMore = false, unavailable = false, repositoryMode = false, searchTimer: ReturnType<typeof setTimeout> | undefined;
  const drafts = new Map<string, string>();
  const decisions = new Map<string, ReviewAction>();
  const draftKey = () => target ? `${target.accountId}/${target.repository}#${target.id}` : "";
  // Routine toolbar actions use icons; form decisions retain explicit wording.
  const actionIcons: Readonly<Record<string, IconName>> = { Refresh: "arrow-clockwise", "GitHub accounts": "github-logo", Repositories: "folder-simple", "New PR": "plus",
    "Back to pull requests": "arrow-left", Retry: "arrow-clockwise", "Open on code host": "arrow-up-right", "Load more": "caret-down" };
  const button = (title: string, action: () => void | Promise<void>, primary = false) => {
    const name = actionIcons[title];
    return h("button", { class: name ? `icon-button${primary ? " icon-button-primary" : ""}` : `button button-small${primary ? " button-primary" : ""}`, type: "button", title, aria: { label: title }, onClick: () => void action() }, name ? icon(name) : title);
  };
  const inboxRoot = h("div", { class: "pr-inbox workspace-page-content" }), repositoryRoot = h("div", { class: "workspace-page-content pr-repository-page" });
  repositoryRoot.hidden = true;
  const repositories = mountRepositoryPullRequests(repositoryRoot, store, controller, host, () => {
    repositoryMode = false; repositories.close(); inboxRoot.hidden = false; back(); void loadAccounts(false);
  });
  const notice = h("p", { class: "pr-notice", role: "status", aria: { live: "polite" } });
  const list = h("div", { class: "pr-inbox-list", aria: { label: "Pull requests" } });
  // The review and its docked side chat share the detail area; only the review re-renders.
  const detailMain = h("div", { class: "pr-detail-main" });
  let sideChatOpen = false;
  const sideChat = createSideChat(store, controller, host, { onClose: () => toggleSideChat(false), resizable: true });
  const chatVisibility = createSideChatVisibility(host, (open) => toggleSideChat(open, false));
  const detailRoot = h("div", { class: "pr-inbox-detail pr-review-layout" }, detailMain, sideChat.element); detailRoot.hidden = true;
  sideChat.element.hidden = true;
  const search = h("input", { type: "search", class: "review-search", placeholder: "Search pull requests…", aria: { label: "Search pull requests" } });
  const accountFilter = createDropdown<string>({ ariaLabel: "GitHub accounts", variant: "pill", onChange(value) { accountId = value; reset(); void loadList(); } });
  const stateFilter = createDropdown<PullState>({ ariaLabel: "Pull request state", variant: "pill", onChange(value) { state = value; reset(); void loadList(); } });
  stateFilter.setOptions(["open", "merged", "closed", "all"].map((value) => ({ value: value as PullState, label: value === "all" ? "Any status" : value[0]!.toUpperCase() + value.slice(1) })), state);
  const refresh = button("Refresh", () => loadAccounts(true));
  const loadMore = h("button", { class: "button button-small pr-action", type: "button", onClick: () => void loadList(true) }, icon("caret-down"), h("span", {}, "Load more"));
  const pagination = h("div", { class: "pr-load-more" }, loadMore);
  const relations: readonly [Involvement, string][] = [["involved", "All my PRs"], ["created", "Created"], ["review_requested", "Review requested"], ["assigned", "Assigned"]];
  const tabs = h("nav", { class: "pr-inbox-tabs", aria: { label: "Pull request involvement" } });
  const summary = h("span", { class: "pr-inbox-summary note" });
  const heading = h("header", { class: "pr-inbox-heading" }, h("div", { class: "pr-inbox-title" }, icon("git-pull-request"), h("h1", {}, "Pull requests"), summary),
    h("div", { class: "page-actions" }, button("GitHub accounts", accountForm), button("Repositories", () => openRepository()), button("New PR", () => openRepository(true), true),
      h("button", { class: "icon-button", type: "button", title: "Back to session", aria: { label: "Back to session" }, onClick: () => controller.openPage("chat") }, icon("x"))));
  const toolbar = h("div", { class: "pr-inbox-toolbar" }, search, accountFilter.element, stateFilter.element, refresh);
  const index = h("div", { class: "pr-inbox-index" }, tabs, toolbar, list, pagination);
  inboxRoot.append(heading, notice, index, detailRoot); root.append(inboxRoot, repositoryRoot);

  function setNotice(text: string, failed = false): void { notice.textContent = text; notice.classList.toggle("error-line", failed); }
  async function openRepository(create = false): Promise<void> {
    if (create && !store.get().projects.length) {
      const path = await controller.selectDirectory("Choose a local repository to create a pull request");
      if (!path || !await controller.registerProject({ path })) return;
    }
    if (root.hidden) return;
    queryGeneration++; detailGeneration++; accountGeneration++; loading = false; repositoryMode = true; inboxRoot.hidden = true;
    chatVisibility.select(undefined);
    repositories.open(create);
  }
  function renderTabs(): void {
    replace(tabs, ...relations.map(([value, title]) => h("button", { type: "button", class: involvement === value ? "active" : "", aria: { pressed: String(involvement === value) }, onClick: () => {
      involvement = value; reset(); renderTabs(); void loadList();
    } }, title)));
  }
  function reset(): void {
    queryGeneration++; detailGeneration++; loading = false; page = 1; hasMore = false; unavailable = false; pulls = []; selected = undefined; target = undefined; detail = undefined;
    chatVisibility.select(undefined);
    index.hidden = false; detailRoot.hidden = true; renderList();
  }
  search.addEventListener("input", () => {
    clearTimeout(searchTimer); queryGeneration++;
    searchTimer = setTimeout(() => { reset(); void loadList(); }, 300);
  });
  async function loadAccounts(refreshAccounts: boolean): Promise<void> {
    const request = ++accountGeneration;
    refresh.disabled = true;
    try {
      const catalog = await host.call("reviews.accounts", { refresh: refreshAccounts });
      if (request !== accountGeneration || repositoryMode || root.hidden) return;
      accounts = catalog.accounts; accountsKnown = true;
      if (target && !accounts.some((account) => account.id === target!.accountId)) back();
      if (accountId && !accounts.some((entry) => entry.id === accountId)) accountId = "";
      accountFilter.setOptions([{ value: "", label: "All accounts" }, ...accounts.map((entry) => ({ value: entry.id, label: entry.login, description: entry.host }))], accountId);
      summary.textContent = accounts.length ? `${accounts.length} account${accounts.length === 1 ? "" : "s"}` : "";
      // Re-discovery does not discard an open review/draft. The list refresh starts from page one.
      if (!accounts.length) { reset(); setNotice(catalog.notices.join(" ")); renderList(); }
      else await loadList();
    } catch (error) { if (request === accountGeneration) { accountsKnown = true; renderList(); setNotice(message(error), true); } }
    finally { refresh.disabled = false; }
  }
  async function loadList(more = false): Promise<void> {
    if (!accounts.length || repositoryMode || root.hidden) return;
    const request = ++queryGeneration, nextPage = more ? page + 1 : 1;
    loading = true; list.setAttribute("aria-busy", "true"); loadMore.disabled = true;
    if (!pulls.length) renderList();
    try {
      const result = await host.call("reviews.inbox", { ...(accountId ? { accountId } : {}), involvement, state, query: search.value, page: nextPage });
      if (request !== queryGeneration || repositoryMode || root.hidden) return;
      const merged = new Map<string, InboxPull>((more ? pulls : []).map((pull) => [key(pull), pull]));
      for (const pull of result.items) {
        const previous = merged.get(key(pull));
        merged.set(key(pull), previous ? { ...pull, accounts: [...new Set([...previous.accounts, ...pull.accounts])] } : pull);
      }
      pulls = [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || key(a).localeCompare(key(b)));
      page = nextPage; hasMore = result.hasMore; unavailable = result.unavailable; loading = false;
      setNotice(result.notices.join(" "), result.notices.length > 0); renderList();
      // Polling never replaces a focused review input or changes the chosen account.
      if (selected && target && !busy && !detailMain.contains(document.activeElement) && !document.querySelector(".popover, .modal-backdrop")) void select(selected, target.accountId, false);
    } catch (error) { if (request === queryGeneration) setNotice(message(error), true); }
    finally {
      if (request === queryGeneration) { loading = false; list.setAttribute("aria-busy", "false"); renderList(); }
    }
  }
  function renderList(): void {
    loadMore.disabled = loading; pagination.hidden = !hasMore;
    if (!accounts.length && !accountsKnown) {
      replace(list, h("div", { class: "pr-inbox-empty", role: "status" }, icon("circle-notch", { className: "spin" }), h("p", {}, "Checking GitHub accounts…"))); return;
    }
    if (!accounts.length) {
      replace(list, h("div", { class: "pr-inbox-empty" }, icon("git-pull-request"), h("h2", {}, "Your reviews, in one place"),
        h("p", {}, "Sign in to GitHub to see pull requests across all your repositories and accounts."),
        h("button", { class: "button button-primary github-sign-in-start", type: "button", onClick: accountForm }, icon("github-logo"), h("span", {}, "Sign in with GitHub")),
        h("p", { class: "note" }, "Existing GitHub CLI logins are detected automatically. GitLab and Bitbucket are available in Repositories."))); return;
    }
    replace(list, ...pulls.map((pull) => h("button", { type: "button", class: "pr-inbox-row", onClick: () => void select(pull) },
      h("span", { class: `pr-row-icon review-state ${pull.state}`, title: pull.draft ? "Draft" : pull.state }, icon("git-pull-request")),
      h("span", { class: "pr-row-main" }, h("strong", {}, pull.title), h("span", { class: "pr-row-meta" }, `${pull.repository} #${pull.id}`, h("span", {}, `by ${pull.author}`), pull.draft ? h("span", {}, "Draft") : null)),
      h("span", { class: "pr-row-accounts note" }, pull.accounts.map((id) => accounts.find((account) => account.id === id)?.login ?? "").filter(Boolean).join(", ")),
      h("time", { class: "pr-row-time note", title: pull.updatedAt }, relativeTime(pull.updatedAt)), icon("caret-right"))),
      pulls.length ? null : h("div", { class: "pr-inbox-empty" }, icon("check"), h("h2", {}, loading ? "Loading pull requests…" : unavailable ? "Pull requests unavailable" : "You're all caught up"),
        h("p", {}, loading ? "Checking your connected accounts." : unavailable ? "Refresh, or sign in to your GitHub accounts again." : "No pull requests match these filters.")));
  }
  function back(): void {
    detailGeneration++; selected = undefined; target = undefined; detail = undefined; index.hidden = false; detailRoot.hidden = true;
    chatVisibility.select(undefined);
  }
  async function select(pull: InboxPull, usingAccount = pull.accounts[0]!, showLoading = true): Promise<void> {
    const request = ++detailGeneration;
    if (!selected || key(selected) !== key(pull)) tab = "overview";
    selected = pull; target = { accountId: usingAccount, repository: pull.repository, id: pull.id };
    index.hidden = true; detailRoot.hidden = false;
    if (showLoading) {
      detail = undefined;
      replace(detailMain, h("div", { class: "pr-detail-navigation" }, button("Back to pull requests", back)),
        h("div", { class: "pr-inbox-empty", role: "status" }, icon("circle-notch", { className: "spin" }), h("p", {}, "Loading review…")));
    }
    try {
      const result = await host.call("reviews.inboxDetail", target);
      if (request !== detailGeneration || repositoryMode || root.hidden) return;
      detail = result;
      chatVisibility.select(pullRequestSideChatContext(`${pull.host}/${pull.repository}`, detail).key);
      if (showLoading || (!busy && !detailMain.contains(document.activeElement) && !document.querySelector(".popover, .modal-backdrop"))) renderDetail();
    } catch (error) {
      if (request !== detailGeneration) return;
      // A failed background refresh must not remove a review the user is reading or editing.
      if (!showLoading && detail) { setNotice(message(error), true); return; }
      replace(detailMain, h("div", { class: "pr-detail-navigation" }, button("Back to pull requests", back)),
        h("div", { class: "pr-inbox-empty", role: "alert" }, icon("warning-circle"), h("h2", {}, "This review could not be loaded"), h("p", {}, message(error)),
          h("div", { class: "page-actions" }, button("Retry", () => select(pull, usingAccount)),
            pull.url.startsWith("https://") ? button("Open on code host", () => controller.openExternal(pull.url)) : null)));
    }
  }
  function renderDetail(): void {
    if (!detail || !selected || !target) return;
    const selectedPull = selected, selectedAccount = target.accountId, reviewDraftKey = draftKey();
    const account = createDropdown<string>({ ariaLabel: "Review as GitHub account", variant: "pill", onChange: (id) => { void select(selectedPull, id); } });
    account.setOptions(accounts.filter((entry) => entry.host === selectedPull.host).map((entry) => ({ value: entry.id, label: `Review as ${entry.login}`, description: entry.host })), target.accountId);
    account.setDisabled(busy);
    const chatContext = pullRequestSideChatContext(`${selected.host}/${selected.repository}`, detail);
    if (sideChatOpen) sideChat.setContext(chatContext);
    renderReviewDetail(detailMain, { detail, provider: "github", authenticated: true, busy, repository: `${selected.host}/${selected.repository}`, tab, account: account.element,
      draft: drafts.get(reviewDraftKey) ?? "", decision: decisions.get(reviewDraftKey) ?? "comment",
      onDraft: (value) => drafts.set(reviewDraftKey, value), onDecision: (value) => decisions.set(reviewDraftKey, value), onTab: (value) => { tab = value; renderDetail(); }, onBack: back,
      onReview: (action, body) => void act(action, body), onState: confirmAction, onTimeline: () => void timeline(), onRefresh: () => { if (!busy) void select(selectedPull, selectedAccount); },
      openLink: (href) => controller.openExternal(href),
      sideChatOpen, onSideChat: () => toggleSideChat(!sideChatOpen),
      onOpenSideChat: (draft) => { toggleSideChat(true); if (draft) sideChat.addDraft(draft); },
      onExplain: () => { toggleSideChat(true); void sideChat.send(EXPLAIN_PROMPT); } });
  }
  /** Docks or hides the side chat; its context follows the selected PR. */
  function toggleSideChat(open: boolean, manual = true): void {
    if (manual) { chatVisibility.set(open); if (open) sideChat.focus(); return; }
    sideChatOpen = open;
    sideChat.element.hidden = !open;
    detailRoot.classList.toggle("with-side-chat", open);
    if (open && detail && selected) { sideChat.setContext(pullRequestSideChatContext(`${selected.host}/${selected.repository}`, detail)); }
    renderDetail();
  }
  async function act(action: ReviewAction, body = ""): Promise<void> {
    if (!detail || !target || !selected || busy) return;
    if (["comment", "request_changes"].includes(action) && !body.trim()) { setNotice("Write a comment before submitting this review.", true); return; }
    const currentTarget = target, pull = selected, head = detail.pull.head, draft = draftKey();
    busy = true; renderDetail();
    try {
      await host.call("reviews.inboxAct", { ...currentTarget, action, body, head });
      if (["comment", "approve", "request_changes"].includes(action) && drafts.get(draft) === body) drafts.delete(draft);
      if (target === currentTarget) { setNotice("Pull request updated."); await select(pull, currentTarget.accountId); }
    } catch (error) { setNotice(message(error), true); }
    finally { busy = false; if (target?.accountId === currentTarget.accountId && selected && key(selected) === key(pull)) renderDetail(); }
  }
  function confirmAction(action: "merge" | "close" | "reopen"): void {
    if (!target) return;
    const captured = target;
    const modal = openModal({ title: `${action === "merge" ? "Merge" : action === "close" ? "Close" : "Reopen"} #${target.id}?`, content: h("div", { class: "modal-body" },
      h("p", {}, `Update ${target.repository} as ${accounts.find((account) => account.id === target!.accountId)?.login ?? "the selected account"}. Repository rules still apply.`),
      h("div", { class: "modal-actions" }, button("Cancel", () => modal.close()), button("Confirm", () => { modal.close(); if (target === captured) void act(action); }, true))) });
  }
  async function timeline(): Promise<void> {
    if (!target || busy) return;
    const captured = target;
    busy = true; renderDetail();
    try {
      // Folder registration is needed only for Timeline, never for listing or reviewing a PR.
      if (!detail?.local) {
        const path = await controller.selectDirectory(`Choose the local folder for ${captured.repository}`);
        if (!path) return;
        const project = await controller.registerProject({ path }); if (!project) return;
      }
      const result = await host.call("reviews.inboxSync", captured);
      await controller.openTimelineWindow({ scope: "project", contextId: result.projectId, checkpointId: result.checkpointId });
      setNotice("PR changes synced to Timeline.");
    } catch (error) { setNotice(message(error), true); }
    finally { busy = false; renderDetail(); }
  }
  /** GitHub identities are added by browser sign-in through gh; Rack never asks for a token. */
  function accountForm(): void {
    openGitHubSignIn({ host, controller, hostEditable: true, accounts,
      onRefresh: () => loadAccounts(true),
      onSignedIn: async (account) => { setNotice(`Signed in to GitHub as ${account.login}.`); await loadAccounts(true); } });
  }
  store.watch((app) => app.page, (_slice, app) => {
    const wasHidden = root.hidden; root.hidden = app.page !== "pull-requests";
    if (root.hidden) { chatVisibility.select(undefined); repositories.close(); repositoryMode = false; queryGeneration++; detailGeneration++; accountGeneration++; loading = false; clearTimeout(searchTimer); return; }
    if (wasHidden) { repositoryMode = false; repositories.close(); inboxRoot.hidden = false; back(); void loadAccounts(false); }
  });
  window.setInterval(() => { if (!root.hidden && !repositoryMode && !document.hidden && !loading && !busy && page === 1) void loadList(); }, 30_000);
  renderTabs(); renderList();
}
