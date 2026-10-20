import type { ReviewAccount } from "../../../features/pull-requests/index.js";
/**
 * Project-scoped review workspace. Query generations discard late replies after navigation.
 * Lists poll while visible; review drafts survive refreshes and are never submitted implicitly.
 */
import type { PullDetail, PullRequest, PullState, ReviewAction, ReviewRepository } from "../../../features/pull-requests/index.js";
import type { Controller } from "../controller.js";
import type { HostClient } from "../host-client.js";
import type { Store } from "../store.js";
import { h, replace, relativeTime } from "../dom.js";
import { icon } from "../icons.js";
import { openModal } from "../components/modal.js";
import { openGitHubSignIn } from "../components/github-sign-in.js";
import { createDropdown } from "../components/dropdown.js";
import { createCheckbox } from "../components/checkbox.js";
import { createSideChat } from "./side-chat.js";
import { createSideChatVisibility } from "./side-chat-state.js";
import { EXPLAIN_PROMPT, pullRequestSideChatContext } from "./side-chat-contexts.js";
import { renderReviewDetail, type ReviewTab } from "./review-detail.js";

export function mountRepositoryPullRequests(root: HTMLElement, store: Store, controller: Controller, host: HostClient, onInbox: () => void): { open(create?: boolean): void; close(): void } {
  let githubAccounts: readonly ReviewAccount[] = [], githubAccount = "";
  let enabled = false, tab: ReviewTab = "overview";
  let projectId = "", remoteName = "", repositories: readonly ReviewRepository[] = [], state: PullState = "open", page = 1;
  let pulls: readonly PullRequest[] = [], detail: PullDetail | undefined, selected: number | undefined;
  let generation = 0, listGeneration = 0, detailGeneration = 0, loading = false, busy = false, hasMore = false;
  const drafts = new Map<string, string>();
  const decisions = new Map<string, ReviewAction>();
  const draftKey = () => `${projectId}/${remoteName}/${githubAccount}/${selected}`;
  const currentRepository = () => repositories.find((remote) => remote.remote === remoteName);
  const githubTarget = () => currentRepository()?.provider === "github" && githubAccount ? { accountId: githubAccount, repository: currentRepository()!.slug } : undefined;
  const authenticated = () => currentRepository()?.provider === "github" ? Boolean(githubAccount) : currentRepository()?.authenticated === true;
  const github = createDropdown<string>({ ariaLabel: "Repository GitHub account", variant: "pill", onChange: (id) => {
    githubAccount = id; resetQuery(); renderContext(); void loadList();
  } });
  const error = h("div", { class: "review-notice", role: "status", aria: { live: "polite" } });
  const list = h("div", { class: "review-list", role: "list", aria: { label: "Pull requests" } });
  const detailBody = h("div", { class: "review-detail pr-detail-main" });
  // The review and its docked side chat; only `detailBody` re-renders.
  let sideChatOpen = false;
  const sideChat = createSideChat(store, controller, host, { onClose: () => toggleSideChat(false), resizable: true });
  const chatVisibility = createSideChatVisibility(host, (open) => toggleSideChat(open, false));
  sideChat.element.hidden = true;
  const detailPane = h("div", { class: "review-detail-pane pr-review-layout" }, detailBody, sideChat.element);
  const search = h("input", { type: "search", class: "review-search", placeholder: "Search pull requests…", aria: { label: "Search pull requests" } });
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    // Invalidate immediately, before debounce, so old results cannot flash under a new query.
    listGeneration++;
    searchTimer = setTimeout(() => { page = 1; void loadList(); }, 300);
  });
  const project = createDropdown<string>({ ariaLabel: "Pull request project", variant: "pill", onChange: (value) => {
    // A project switch stays on the review page and does not discard the selected chat.
    projectId = value; void loadRepositories();
  } });
  const remote = createDropdown<string>({ ariaLabel: "Code host remote", variant: "pill", onChange: (value) => {
    remoteName = value; configureGithub(); resetQuery(); void loadList(); renderContext();
  } });
  const filter = createDropdown<PullState>({ ariaLabel: "Pull request state", variant: "pill", onChange: (value) => {
    state = value; page = 1; void loadList();
  } });
  filter.setOptions(["open", "merged", "closed", "all"].map((value) => ({ value: value as PullState, label: value[0]!.toUpperCase() + value.slice(1) })), state);
  const refresh = button("Refresh", async () => { await loadRepositories(false); }, "arrow-clockwise");
  const create = button("New pull request", () => createForm(), "plus", "button button-primary button-small");
  const connect = button("Connect", () => connectForm(), "key");
  const context = h("div", { class: "review-context" });
  const previous = button("Previous", () => { if (page > 1) { page--; void loadList(); } }, "arrow-left");
  const next = button("Next", () => { if (hasMore) { page++; void loadList(); } }, "arrow-right");
  const pagination = h("div", { class: "review-pagination" });
  const heading = h("header", { class: "page-heading pr-repository-heading" },
    h("div", { class: "pr-inbox-title" }, button("Back to all accounts", onInbox, "arrow-left"), icon("folder-simple"), h("h1", {}, "Repository pull requests")),
    h("div", { class: "page-actions" }, project.element, remote.element, github.element, connect,
      h("button", { class: "icon-button", title: "Back to session", aria: { label: "Back to session" }, onClick: () => controller.openPage("chat") }, icon("x"))));
  const workspace = h("div", { class: "review-workspace" }, h("aside", { class: "review-index" }, list, pagination), detailPane);
  root.append(heading, context,
    h("div", { class: "review-toolbar" }, search, filter.element, refresh, create), error,
    workspace);

  function button(title: string, action: () => void | Promise<void>, name?: Parameters<typeof icon>[0], className = "button button-small"): HTMLButtonElement {
    return h("button", { class: name ? `icon-button${className.includes("button-primary") ? " icon-button-primary" : ""}` : className, type: "button", title, aria: { label: title }, onClick: () => { void action(); } }, name ? icon(name) : title);
  }
  function notice(message: string, failure = false): void {
    error.textContent = message; error.classList.toggle("error-line", failure);
  }
  function resetQuery(): void {
    generation++; listGeneration++; detailGeneration++; loading = false; page = 1; selected = undefined; detail = undefined; pulls = []; hasMore = false;
    chatVisibility.select(undefined);
    renderList(); renderDetail();
  }
  function configureGithub(): void {
    const repo = currentRepository(), available = githubAccounts.filter((account) => account.host === repo?.host);
    if (!available.some((account) => account.id === githubAccount)) githubAccount = available[0]?.id ?? "";
    github.setOptions(available.map((account) => ({ value: account.id, label: account.login, description: account.host })), githubAccount);
    github.setDisabled(!available.length || busy);
    github.element.hidden = repo?.provider !== "github" || !available.length;
  }
  function renderContext(): void {
    const repo = currentRepository();
    connect.disabled = !repo || busy;
    create.disabled = !repo || busy;
    search.disabled = !repo;
    github.setDisabled(busy || !githubAccount);
    project.setDisabled(busy); remote.setDisabled(busy || !repositories.length);
    if (!repo) {
      replace(context, h("span", { class: "note" }, projectId ? "No supported code host remote. Add a GitHub, GitLab or Bitbucket Cloud remote to this project." : "Choose a project to review its pull requests."));
      return;
    }
    // Icon-only control: update its name, never its text, or the icon would be replaced.
    const connectLabel = repo.provider === "github" ? (authenticated() ? "GitHub accounts" : "Sign in with GitHub") : (authenticated() ? "Connection" : "Connect");
    connect.title = connectLabel; connect.setAttribute("aria-label", connectLabel);
    connect.replaceChildren(icon(repo.provider === "github" ? "github-logo" : "key"));
    const providerName = repo.provider === "github" ? "GitHub" : repo.provider === "gitlab" ? "GitLab" : "Bitbucket";
    replace(context, h("span", { class: "review-provider", title: providerName }, repo.provider === "github" ? icon("github-logo") : h("span", {}, providerName)), h("strong", {}, repo.slug),
      h("span", { class: "review-branch note", title: "Current branch" }, icon("git-branch"), repo.branch || "Detached HEAD"),
      h("span", { class: `review-connection${authenticated() ? " connected" : ""}` }, icon(authenticated() ? "check-circle" : "lock-simple"),
        authenticated() ? "Connected" : "Public access · sign in to write"));
  }
  async function loadRepositories(reset = true): Promise<void> {
    if (reset) { resetQuery(); repositories = []; configureGithub(); renderContext(); }
    const identity = ++generation, id = projectId;
    if (!id) { repositories = []; renderContext(); replace(list, h("p", { class: "page-empty" }, "Add a local repository folder to Rack to create or publish a pull request.")); return; }
    refresh.disabled = true;
    notice("Loading repository…");
    try {
      const [result, catalog] = await Promise.all([host.call("reviews.repositories", { projectId: id }), host.call("reviews.accounts", {}).catch(() => ({ accounts: [] as readonly ReviewAccount[], notices: [] }))]);
      if (identity !== generation) return;
      repositories = result; githubAccounts = catalog.accounts;
      const nextRemote = result.find((item) => item.remote === remoteName)?.remote ?? result[0]?.remote ?? "";
      if (nextRemote !== remoteName) { remoteName = nextRemote; resetQuery(); }
      configureGithub();
      remote.setOptions(result.map((item) => ({ value: item.remote, label: `${item.remote} · ${item.provider}`, description: `${item.host}/${item.slug}` })), remoteName);
      renderContext();
      notice("");
      if (remoteName) await loadList();
      else { replace(list, h("p", { class: "page-empty" }, "Connect a repository to get started.")); renderDetail(); }
    } catch (reason) { if (identity === generation) notice(message(reason), true); }
    finally { refresh.disabled = false; }
  }
  async function loadList(): Promise<void> {
    if (!projectId || !remoteName) return;
    const request = ++listGeneration, contextId = generation;
    loading = true; list.setAttribute("aria-busy", "true"); notice("Refreshing pull requests…");
    try {
      const account = githubTarget();
      const result = account ? await host.call("reviews.inboxRepository", { ...account, query: search.value, state, page })
        : await host.call("reviews.list", { projectId, remote: remoteName, query: search.value, state, page });
      if (request !== listGeneration || contextId !== generation) return;
      pulls = result.items; hasMore = result.hasMore; loading = false;
      notice(`Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
      renderList();
      // Keep a PR's draft/detail when search filters it out; selecting another PR is explicit.
      if (selected !== undefined && !detailBody.contains(document.activeElement) && !document.querySelector(".popover, .modal-backdrop") && !busy) void select(selected, false);
    } catch (reason) { if (request === listGeneration && contextId === generation) notice(message(reason), true); }
    finally { if (request === listGeneration) { loading = false; list.setAttribute("aria-busy", "false"); } }
  }
  function renderList(): void {
    // Same row anatomy as the account inbox: state icon, title with number/author, time, caret.
    const stateLabel = (pull: PullRequest) => pull.draft && pull.state === "open" ? "Draft" : pull.state[0]!.toUpperCase() + pull.state.slice(1);
    replace(list, ...pulls.map((pull) => h("button", { class: `pr-inbox-row${pull.id === selected ? " selected" : ""}`, type: "button", aria: { current: String(pull.id === selected) }, onClick: () => void select(pull.id) },
      h("span", { class: `pr-row-icon review-state ${pull.draft && pull.state === "open" ? "draft" : pull.state}`, title: stateLabel(pull) }, icon(pull.state === "merged" ? "git-merge" : pull.state === "closed" ? "x-circle" : pull.draft ? "circle-dashed" : "git-pull-request")),
      h("span", { class: "pr-row-main" }, h("strong", {}, pull.title), h("span", { class: "pr-row-meta" }, `#${pull.id}`, h("span", {}, `by ${pull.author}`), h("span", {}, stateLabel(pull)))),
      h("span", {}),
      h("time", { class: "pr-row-time note", title: pull.updatedAt }, relativeTime(pull.updatedAt)), icon("caret-right"))),
      pulls.length ? null : h("div", { class: "pr-inbox-empty", role: "status" },
        icon(loading ? "circle-notch" : "check", loading ? { className: "spin" } : undefined), h("p", {}, loading ? "Loading pull requests…" : search.value.trim() ? "No pull requests match this search." : `No ${state === "all" ? "" : `${state} `}pull requests.`)));
    previous.disabled = page === 1 || loading; next.disabled = !hasMore || loading;
    replace(pagination, previous, h("span", { class: "note" }, `Page ${page}`), next);
  }
  async function select(id: number, showLoading = true): Promise<void> {
    const identity = generation, request = ++detailGeneration;
    if (selected !== id) { selected = id; detail = undefined; }
    if (showLoading) renderDetail();
    renderList();
    try {
      const account = githubTarget();
      const result = account ? await host.call("reviews.inboxDetail", { ...account, id }) : await host.call("reviews.detail", { projectId, remote: remoteName, id });
      if (identity !== generation || request !== detailGeneration) return;
      detail = result;
      const repo = currentRepository();
      chatVisibility.select(repo ? pullRequestSideChatContext(`${repo.host}/${repo.slug}`, detail).key : undefined);
      if (showLoading || (!busy && !detailBody.contains(document.activeElement) && !document.querySelector(".popover, .modal-backdrop"))) renderDetail();
    } catch (reason) {
      if (identity === generation && request === detailGeneration) {
        if (!showLoading && detail) { notice(message(reason), true); return; }
        const url = pulls.find((pull) => pull.id === id)?.url;
        replace(detailBody, h("div", { class: "pr-detail-navigation" }, button("Back to pull requests", back, "arrow-left")),
          h("div", { class: "pr-inbox-empty", role: "alert" }, icon("warning-circle"), h("h2", {}, "This review could not be loaded"), h("p", {}, message(reason)),
            h("div", { class: "page-actions" }, button("Retry", () => select(id), "arrow-clockwise"),
              url?.startsWith("https://") ? button("Open on code host", () => controller.openExternal(url), "arrow-up-right") : null)));
      }
    }
  }
  function back(): void { selected = undefined; detail = undefined; detailGeneration++; chatVisibility.select(undefined); renderDetail(); }
  function renderDetail(): void {
    workspace.classList.toggle("is-reading", selected !== undefined);
    detailPane.hidden = selected === undefined;
    if (!detail) {
      replace(detailBody, h("div", { class: "pr-detail-navigation" }, button("Back to pull requests", back, "arrow-left")),
        h("div", { class: "pr-inbox-empty", role: "status" }, icon("circle-notch", { className: "spin" }), h("p", {}, "Loading review…")));
      return;
    }
    const reviewDraftKey = draftKey();
    const repo = currentRepository();
    const chatContext = repo ? pullRequestSideChatContext(`${repo.host}/${repo.slug}`, detail) : undefined;
    if (sideChatOpen) sideChat.setContext(chatContext);
    renderReviewDetail(detailBody, { detail, repository: currentRepository()?.slug ?? "", provider: currentRepository()?.provider ?? "github", authenticated: authenticated(),
      busy, tab, draft: drafts.get(reviewDraftKey) ?? "", decision: decisions.get(reviewDraftKey) ?? "comment",
      onDraft: (value) => drafts.set(reviewDraftKey, value), onDecision: (value) => decisions.set(reviewDraftKey, value),
      onTab: (value) => { tab = value; renderDetail(); }, onBack: back,
      onReview: (action, body) => void perform(action, body), onState: confirmAction, onTimeline: () => void viewTimeline(), onRefresh: () => { if (!busy && selected !== undefined) void select(selected); },
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
    detailPane.classList.toggle("with-side-chat", open);
    const repo = currentRepository();
    if (open && detail && repo) { sideChat.setContext(pullRequestSideChatContext(`${repo.host}/${repo.slug}`, detail)); }
    renderDetail();
  }
  async function mutate(action: () => Promise<void>, success: string): Promise<void> {
    if (busy) return;
    const identity = generation;
    busy = true; renderContext(); renderDetail();
    try { await action(); if (identity === generation) notice(success); }
    catch (reason) { if (identity === generation) notice(message(reason), true); }
    finally { busy = false; if (identity === generation) { renderContext(); renderDetail(); } }
  }
  async function perform(action: ReviewAction, body = ""): Promise<void> {
    if (!detail || selected === undefined) return;
    if (["comment", "request_changes"].includes(action) && !body.trim()) { notice("Write a comment before submitting this review.", true); return; }
    const id = selected, current = detail.pull, key = draftKey(), project = projectId, remote = remoteName, account = githubTarget();
    await mutate(async () => {
      if (account) await host.call("reviews.inboxAct", { ...account, id, action, body, head: current.head });
      else await host.call("reviews.act", { projectId: project, remote, id, action, body, head: current.head });
      // A slow submission must not erase text typed for a subsequent review.
      // State actions such as merge also leave an unsubmitted draft intact.
      if (drafts.get(key) === body) drafts.delete(key);
      if (project === projectId && remote === remoteName && id === selected) await select(id);
    }, "Pull request updated.");
  }
  function confirmAction(action: "merge" | "close" | "reopen"): void {
    if (!detail) return;
    const id = detail.pull.id, identity = generation;
    const modal = openModal({ title: `${action === "merge" ? "Merge" : action === "close" ? "Close" : "Reopen"} #${id}?`, content: h("div", { class: "modal-body" },
      h("p", {}, action === "merge" ? "Merge the reviewed commits on the code host. Repository protection rules still apply. Your local branch stays as it is." : "Update this pull request on the code host."),
      h("div", { class: "modal-actions" }, button("Cancel", () => modal.close()), button("Confirm", () => { modal.close(); if (identity === generation && selected === id) void perform(action); }, undefined, "button button-primary button-small"))) });
  }
  async function viewTimeline(): Promise<void> {
    if (selected === undefined) return;
    const id = selected, project = projectId, remote = remoteName, account = githubTarget();
    await mutate(async () => {
      const result = account ? await host.call("reviews.inboxSync", { ...account, id, projectId: project }) : await host.call("reviews.sync", { projectId: project, remote, id });
      await controller.openTimelineWindow({ scope: "project", contextId: project, checkpointId: result.checkpointId });
    }, "PR changes synced to Timeline.");
  }
  function connectForm(): void {
    const project = projectId, remote = remoteName, identity = generation, repo = currentRepository();
    // GitHub uses browser sign-in through gh. GitLab and Bitbucket keep their session connections.
    if (repo?.provider === "github") {
      openGitHubSignIn({ host, controller, hostname: repo.host, accounts: githubAccounts.filter((account) => account.host === repo.host),
        onRefresh: () => loadRepositories(false),
        onSignedIn: async (account) => { githubAccount = account.id; if (identity === generation) await loadRepositories(false); } });
      return;
    }
    const token = h("input", { type: "password", placeholder: "Access token", aria: { label: "Code host access token" } });
    token.autocomplete = "off";
    const failure = h("p", { class: "error-line", role: "alert" });
    const save = button("Connect", async () => {
      save.disabled = true; failure.textContent = "";
      try {
        await host.call("reviews.connect", { projectId: project, remote, token: token.value });
        token.value = ""; modal.close(); if (identity === generation) await loadRepositories(false);
      } catch (reason) { failure.textContent = message(reason); save.disabled = false; }
    }, undefined, "button button-primary button-small");
    const modal = openModal({ title: `Connect ${currentRepository()?.host ?? "code host"}`, onClose: () => { token.value = ""; }, content: h("div", { class: "modal-body review-form" },
      h("p", { class: "note" }, "Rack uses your existing glab login or environment token when available. You can also enter a repository access token below. It stays in memory until the app closes; Rack does not save it to disk."),
      token, failure, h("div", { class: "modal-actions" }, button("Cancel", () => modal.close()), save)) });
  }
  /**
   * New pull request dialog. The target defaults to the remote's main,
   * master or develop branch (in that order) when it exists, otherwise "main".
   * Progress ("Publishing…", "Creating…") and failures use separate lines so
   * an in-progress message is never styled as an error.
   */
  function createForm(): void {
    const repo = currentRepository(); if (!repo) return;
    const project = projectId, remote = remoteName, identity = generation;
    let account = githubTarget();
    const createAccount = createDropdown<string>({ ariaLabel: "Create as GitHub account", variant: "field", onChange: (id) => { account = { accountId: id, repository: repo.slug }; } });
    createAccount.setOptions(githubAccounts.filter((entry) => entry.host === repo.host).map((entry) => ({ value: entry.id, label: entry.login, description: entry.host, icon: "github-logo" as const })), account?.accountId);
    const showAccount = repo.provider === "github" && Boolean(account);
    const branchNames = [...new Set(repo.branches.map((branch) => branch.replace(`${repo.remote}/`, "")).filter((branch) => branch && branch !== "HEAD" && branch !== repo.remote))];
    const defaultTarget = ["main", "master", "develop"].find((name) => repo.branches.includes(`${repo.remote}/${name}`)) ?? "main";
    const title = h("input", { placeholder: "Summarize the change", aria: { label: "Pull request title" } });
    const body = h("textarea", { rows: 6, placeholder: "What changed, and why?", aria: { label: "Pull request description" } });
    const source = h("input", { value: repo.branch, placeholder: "feature/branch", aria: { label: "Source branch" } });
    const target = h("input", { value: defaultTarget, placeholder: "main", aria: { label: "Target branch" } });
    const suggestions = h("datalist", { id: "review-branches" }, ...branchNames.map((branch) => h("option", { value: branch })));
    source.setAttribute("list", "review-branches"); target.setAttribute("list", "review-branches");
    let draft = false;
    const draftToggle = createCheckbox({ label: "Create as draft", onToggle: (checked) => { draft = checked; } });
    const status = h("p", { class: "note review-form-status", role: "status", aria: { live: "polite" } });
    const failure = h("p", { class: "error-line", role: "alert" }); failure.hidden = true;
    const report = (text: string, failed = false) => {
      status.textContent = failed ? "" : text; failure.textContent = failed ? text : ""; failure.hidden = !failed;
    };
    const labeled = (title: string, name: Parameters<typeof icon>[0], action: () => void | Promise<void>, primary = false) =>
      h("button", { class: `button button-small pr-action${primary ? " button-primary" : ""}`, type: "button", onClick: () => { void action(); } }, icon(name), h("span", {}, title));
    const publish = labeled("Publish branch", "arrow-up", async () => {
      publish.disabled = true; report("Publishing the source branch…");
      try { await host.call("reviews.publish", { projectId: project, remote, branch: source.value.trim() }); report("Branch published."); }
      catch (reason) { report(message(reason), true); }
      finally { publish.disabled = false; }
    });
    publish.title = "Push committed changes on the source branch. Uncommitted files are not included.";
    const submit = labeled("Create pull request", "git-pull-request", async () => {
      if (!title.value.trim() || !source.value.trim() || !target.value.trim()) { report("Enter a title, source branch and target branch.", true); return; }
      if (source.value.trim() === target.value.trim()) { report("Choose different source and target branches.", true); return; }
      submit.disabled = true; createAccount.setDisabled(true); report("Creating the pull request…");
      const submittingAccount = account;
      try {
        const input = { title: title.value.trim(), body: body.value, source: source.value.trim(), target: target.value.trim(), draft };
        const pull = submittingAccount ? await host.call("reviews.inboxCreate", { ...submittingAccount, input }) : await host.call("reviews.create", { projectId: project, remote, input });
        modal.close();
        if (identity === generation) { if (submittingAccount) { githubAccount = submittingAccount.accountId; configureGithub(); } state = "open"; filter.setValue(state); page = 1; search.value = ""; await loadList(); await select(pull.id); }
      } catch (reason) { report(message(reason), true); submit.disabled = false; createAccount.setDisabled(false); }
    }, true);
    submit.disabled = !authenticated(); publish.disabled = !repo.branch;
    const providerName = repo.provider === "github" ? "GitHub" : repo.provider === "gitlab" ? "GitLab" : "Bitbucket";
    const modal = openModal({ title: "New pull request", className: "review-create-modal", content: h("div", { class: "modal-body review-form" },
      h("p", { class: "review-create-repository note" }, repo.provider === "github" ? icon("github-logo") : null, `${providerName} · ${repo.slug}`),
      showAccount ? h("label", {}, "Create as", createAccount.element) : null,
      h("label", {}, "Title", title), h("label", {}, "Description", body),
      h("div", { class: "review-branch-fields" }, h("label", {}, "From", source), icon("arrow-right"), h("label", {}, "Into", target)), suggestions,
      // The visible text toggles the checkbox too, like a native label.
      h("div", { class: "review-draft-toggle" }, draftToggle.element, h("span", { onClick: () => draftToggle.element.click() }, "Create as draft"),
        h("span", { class: "note" }, "Reviewers are not asked until it is marked ready.")),
      authenticated() ? null : h("p", { class: "note" }, repo.provider === "github" ? "Sign in with GitHub before creating a pull request." : "Connect an account before creating a pull request."),
      h("p", { class: "note" }, "The source branch must exist on the remote. Publish pushes committed changes only; it never commits your working files."),
      status, failure,
      h("div", { class: "modal-actions review-create-actions" }, publish, h("span", { class: "spacer" }),
        h("button", { class: "button button-small", type: "button", onClick: () => modal.close() }, "Cancel"), submit)) });
    title.focus();
  }
  let lastRequestedProject: string | undefined;
  store.watch((app) => [app.page, app.projects, app.reviewProjectId], (_slice, app) => {
    const previousProjectId = projectId;
    const wasHidden = root.hidden; root.hidden = app.page !== "pull-requests" || !enabled;
    if (app.reviewProjectId !== lastRequestedProject) {
      lastRequestedProject = app.reviewProjectId;
      if (app.projects.some((item) => item.id === app.reviewProjectId)) projectId = app.reviewProjectId!;
    }
    if (!app.projects.some((item) => item.id === projectId)) projectId = app.selection.projectId ?? app.projects[0]?.id ?? "";
    project.setOptions(app.projects.map((item) => ({ value: item.id, label: item.path.split("/").pop() ?? item.path })), projectId);
    if (!root.hidden && (wasHidden || projectId !== previousProjectId)) { if (!projectId) renderContext(); else void loadRepositories(); }
  });
  window.setInterval(() => { if (enabled && !root.hidden && !loading && !busy && !document.hidden) void loadList(); }, 30_000);
  renderContext(); renderDetail();
  return {
    open(create = false) {
      enabled = true; root.hidden = false;
      projectId = store.get().reviewProjectId ?? store.get().selection.projectId ?? store.get().projects[0]?.id ?? "";
      void loadRepositories().then(() => { if (create && enabled) createForm(); });
    },
    close() { chatVisibility.select(undefined); enabled = false; root.hidden = true; generation++; listGeneration++; detailGeneration++; },
  };
}
function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
