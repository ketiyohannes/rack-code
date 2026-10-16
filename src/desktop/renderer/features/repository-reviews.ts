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
import { createDropdown } from "../components/dropdown.js";
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
  const detailBody = h("div", { class: "review-detail" });
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
  const previous = button("Previous", () => { if (page > 1) { page--; void loadList(); } });
  const next = button("Next", () => { if (hasMore) { page++; void loadList(); } });
  const pagination = h("div", { class: "review-pagination" });
  const heading = h("header", { class: "page-heading" }, h("div", {}, h("h1", {}, "Repository pull requests")),
    h("div", { class: "page-actions" }, button("All accounts", onInbox), project.element, remote.element, github.element, connect,
      h("button", { class: "icon-button", title: "Back to session", aria: { label: "Back to session" }, onClick: () => controller.openPage("chat") }, icon("x"))));
  const workspace = h("div", { class: "review-workspace" }, h("aside", { class: "review-index" }, list, pagination), detailBody);
  root.append(heading, context,
    h("div", { class: "review-toolbar" }, search, filter.element, refresh, create), error,
    workspace);

  function button(title: string, action: () => void | Promise<void>, name?: Parameters<typeof icon>[0], className = "button button-small"): HTMLButtonElement {
    return h("button", { class: className, type: "button", title, onClick: () => { void action(); } }, name ? icon(name) : null, title);
  }
  function notice(message: string, failure = false): void {
    error.textContent = message; error.classList.toggle("error-line", failure);
  }
  function resetQuery(): void {
    generation++; listGeneration++; detailGeneration++; loading = false; page = 1; selected = undefined; detail = undefined; pulls = []; hasMore = false;
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
    connect.textContent = authenticated() ? "Connection" : "Connect";
    replace(context, h("span", { class: "review-provider" }, repo.provider), h("strong", {}, repo.slug),
      h("span", { class: "note" }, repo.branch || "Detached HEAD"),
      h("span", { class: "review-connection" }, authenticated() ? "Connected" : "Public access · connect to write"));
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
    replace(list, ...pulls.map((pull) => h("button", { class: `review-row ${pull.id === selected ? "selected" : ""}`, type: "button", aria: { current: String(pull.id === selected) }, onClick: () => void select(pull.id) },
      h("div", { class: "review-row-heading" }, icon("git-pull-request"), h("span", { class: `review-state ${pull.state}` }, pull.draft ? "Draft" : pull.state), h("span", { class: "mono" }, `#${pull.id}`)),
      h("strong", {}, pull.title), h("span", { class: "note" }, `${pull.author} · ${relativeTime(pull.updatedAt)}`))),
      pulls.length ? null : h("p", { class: "page-empty" }, loading ? "Loading pull requests…" : "No pull requests match this search."));
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
      detail = result; if (showLoading || (!busy && !detailBody.contains(document.activeElement) && !document.querySelector(".popover, .modal-backdrop"))) renderDetail();
    } catch (reason) {
      if (identity === generation && request === detailGeneration) {
        if (!showLoading && detail) { notice(message(reason), true); return; }
        const url = pulls.find((pull) => pull.id === id)?.url;
        replace(detailBody, button("Back to pull requests", back), h("p", { class: "page-empty error-line", role: "alert" }, message(reason)), button("Retry", () => select(id)),
          url?.startsWith("https://") ? button("Open on code host", () => { window.open(url, "_blank", "noopener"); }, "arrow-up-right") : null);
      }
    }
  }
  function back(): void { selected = undefined; detail = undefined; detailGeneration++; renderDetail(); }
  function renderDetail(): void {
    workspace.classList.toggle("is-reading", selected !== undefined);
    detailBody.hidden = selected === undefined;
    if (!detail) { replace(detailBody, h("div", { class: "page-actions" }, button("Back to pull requests", back)), h("p", { class: "page-empty" }, "Loading review…")); return; }
    const reviewDraftKey = draftKey();
    renderReviewDetail(detailBody, { detail, repository: currentRepository()?.slug ?? "", provider: currentRepository()?.provider ?? "github", authenticated: authenticated(),
      busy, tab, draft: drafts.get(reviewDraftKey) ?? "", decision: decisions.get(reviewDraftKey) ?? "comment",
      onDraft: (value) => drafts.set(reviewDraftKey, value), onDecision: (value) => decisions.set(reviewDraftKey, value),
      onTab: (value) => { tab = value; renderDetail(); }, onBack: back,
      onReview: (action, body) => void perform(action, body), onState: confirmAction, onTimeline: () => void viewTimeline(), onRefresh: () => { if (!busy && selected !== undefined) void select(selected); } });
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
    const token = h("input", { type: "password", placeholder: "Access token", aria: { label: "Code host access token" } });
    token.autocomplete = "off";
    const failure = h("p", { class: "error-line", role: "alert" });
    const save = button("Connect", async () => {
      save.disabled = true; failure.textContent = "";
      try {
        if (repo?.provider === "github") {
          const account = await host.call("reviews.accountConnect", { host: repo.host, token: token.value });
          githubAccount = account.id;
        } else await host.call("reviews.connect", { projectId: project, remote, token: token.value });
        token.value = ""; modal.close(); if (identity === generation) await loadRepositories(false);
      } catch (reason) { failure.textContent = message(reason); save.disabled = false; }
    }, undefined, "button button-primary button-small");
    const modal = openModal({ title: `Connect ${currentRepository()?.host ?? "code host"}`, onClose: () => { token.value = ""; }, content: h("div", { class: "modal-body review-form" },
      h("p", { class: "note" }, "Rack can use your existing gh/glab login or environment token. You can also enter a repository access token below. It stays in memory until the app closes; Rack does not save it to disk."),
      token, failure, h("div", { class: "modal-actions" }, button("Cancel", () => modal.close()), save)) });
  }
  function createForm(): void {
    const repo = currentRepository(); if (!repo) return;
    const project = projectId, remote = remoteName, identity = generation;
    let account = githubTarget();
    const createAccount = createDropdown<string>({ ariaLabel: "Create as GitHub account", variant: "field", onChange: (id) => { account = { accountId: id, repository: repo.slug }; } });
    createAccount.setOptions(githubAccounts.filter((entry) => entry.host === repo.host).map((entry) => ({ value: entry.id, label: `Create as ${entry.login}`, description: entry.host })), account?.accountId);
    createAccount.element.hidden = repo.provider !== "github" || !account;
    const title = h("input", { placeholder: "Title", aria: { label: "Pull request title" } });
    const body = h("textarea", { rows: 6, placeholder: "What changed, and why?", aria: { label: "Pull request description" } });
    const source = h("input", { value: repo.branch, placeholder: "Source branch", aria: { label: "Source branch" } });
    const target = h("input", { value: "main", placeholder: "Target branch", aria: { label: "Target branch" } });
    const suggestions = h("datalist", { id: "review-branches" }, ...repo.branches.map((branch) => h("option", { value: branch.replace(`${repo.remote}/`, "") })));
    source.setAttribute("list", "review-branches"); target.setAttribute("list", "review-branches");
    const draft = h("input", { type: "checkbox", aria: { label: "Create as draft" } });
    const failure = h("p", { class: "error-line", role: "alert" });
    const publish = button("Publish source branch", async () => {
      publish.disabled = true; failure.textContent = "Publishing…";
      try { await host.call("reviews.publish", { projectId: project, remote, branch: source.value.trim() }); failure.textContent = "Branch published."; }
      catch (reason) { failure.textContent = message(reason); }
      finally { publish.disabled = false; }
    }, "arrow-up");
    const submit = button("Create pull request", async () => {
      if (!title.value.trim() || !source.value.trim() || !target.value.trim()) { failure.textContent = "Enter a title, source branch and target branch."; return; }
      if (source.value === target.value) { failure.textContent = "Choose different source and target branches."; return; }
      submit.disabled = true; createAccount.setDisabled(true); failure.textContent = "Creating…";
      const submittingAccount = account;
      try {
        const input = { title: title.value.trim(), body: body.value, source: source.value.trim(), target: target.value.trim(), draft: draft.checked };
        const pull = submittingAccount ? await host.call("reviews.inboxCreate", { ...submittingAccount, input }) : await host.call("reviews.create", { projectId: project, remote, input });
        modal.close();
        if (identity === generation) { if (submittingAccount) { githubAccount = submittingAccount.accountId; configureGithub(); } state = "open"; filter.setValue(state); page = 1; search.value = ""; await loadList(); await select(pull.id); }
      } catch (reason) { failure.textContent = message(reason); submit.disabled = false; createAccount.setDisabled(false); }
    }, "plus", "button button-primary button-small");
    submit.disabled = !authenticated(); publish.disabled = !repo.branch;
    const modal = openModal({ title: "New pull request", className: "review-create-modal", content: h("div", { class: "modal-body review-form" },
      h("p", { class: "note" }, `${repo.provider} · ${repo.slug}`), createAccount.element, title, body,
      h("label", {}, "Source branch", source), h("label", {}, "Target branch", target), suggestions,
      h("label", { class: "review-draft" }, draft, "Create as draft"),
      authenticated() ? null : h("p", { class: "note" }, "Connect an account before creating a pull request."),
      h("p", { class: "note" }, "The source branch must be published. Publishing pushes committed changes only; it does not commit your working files."),
      failure, h("div", { class: "modal-actions" }, publish, button("Cancel", () => modal.close()), submit)) });
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
    close() { enabled = false; root.hidden = true; generation++; listGeneration++; detailGeneration++; },
  };
}
function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
