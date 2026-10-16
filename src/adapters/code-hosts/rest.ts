/** REST translation for GitHub, GitLab and Bitbucket Cloud, shared by repository and account workflows. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CreatePull, PullDetail, PullList, PullRequest, PullRequestGateway, PullState, ReviewAction, ReviewCheck, ReviewComment, ReviewRepository } from "../../features/pull-requests/index.js";
import { git, remotes, savedReview, syncReview, type Remote } from "./repository.js";
const exec = promisify(execFile);
type Data = Record<string, any>;
const enc = encodeURIComponent;
const PAGE_SIZE = 50;
const MAX_BYTES = 2_000_000;
const str = (value: unknown): string => typeof value === "string" ? value : "";

/** Tokens entered in Rack are host-memory only. Existing CLI logins and env tokens need no entry. */
export class RestCodeHosts implements PullRequestGateway {
  private readonly tokens = new Map<string, string>();
  constructor(private readonly fetcher: typeof fetch = fetch,
    private readonly credential?: (remote: Remote) => Promise<string | undefined>) {}
  private async remote(path: string, name: string): Promise<Remote> {
    const remote = (await remotes(path)).find((entry) => entry.name === name);
    if (!remote) throw new Error("Choose a GitHub, GitLab, or Bitbucket Cloud remote for this project.");
    return remote;
  }
  private async token(remote: Remote): Promise<string | undefined> {
    // A bound account must never fall back to another active CLI login.
    if (this.credential) return this.credential(remote);
    const saved = this.tokens.get(remote.host);
    if (saved) return saved;
    // Cloud environment tokens must never be forwarded to enterprise hosts.
    const environment = remote.host === "github.com" ? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
      : remote.host === "gitlab.com" ? process.env.GITLAB_TOKEN ?? process.env.GL_TOKEN
        : remote.host === "bitbucket.org" ? process.env.BITBUCKET_TOKEN : undefined;
    if (environment) return environment;
    try {
      if (remote.provider === "bitbucket") return undefined;
      const tool = remote.provider === "github" ? "gh" : "glab";
      return (await exec(tool, ["auth", "token", "--hostname", remote.host], { timeout: 5000, maxBuffer: 16_384 })).stdout.trim() || undefined;
    } catch { return undefined; }
  }
  async repositories(path: string): Promise<readonly ReviewRepository[]> {
    const [all, branch, branches] = await Promise.all([remotes(path), git(path, ["branch", "--show-current"]), git(path, ["for-each-ref", "--count=500", "--format=%(refname:short)", "refs/heads", "refs/remotes"])]);
    return Promise.all(all.map(async (remote) => ({ remote: remote.name, host: remote.host, provider: remote.provider, slug: remote.slug, branch,
      branches: branches.split("\n").filter(Boolean), authenticated: Boolean(await this.token(remote)) })));
  }
  async connect(path: string, name: string, token: string): Promise<void> {
    const remote = await this.remote(path, name);
    if (!token.trim()) { this.tokens.delete(remote.host); return; }
    // Validate first so a mistyped token cannot replace a working connection.
    await this.request(remote, remote.provider === "github" ? `/repos/${remote.slug}` : remote.provider === "gitlab" ? `/projects/${enc(remote.slug)}` : `/repositories/${remote.slug}`, "GET", undefined, token.trim());
    this.tokens.set(remote.host, token.trim());
  }
  private root(remote: Remote): string {
    return remote.provider === "github" ? `/repos/${remote.slug}/pulls`
      : remote.provider === "gitlab" ? `/projects/${enc(remote.slug)}/merge_requests` : `/repositories/${remote.slug}/pullrequests`;
  }
  /** Bounded response streaming, timeout and same-origin redirects protect host memory and credentials. */
  async request(remote: Remote, path: string, method = "GET", body?: unknown, tokenOverride?: string, raw = false): Promise<any> {
    const token = tokenOverride ?? await this.token(remote);
    if (method !== "GET" && !token) throw new Error(`Connect ${remote.provider} before changing a pull request.`);
    let url = new URL(`${remote.api}${path}`);
    const headers: Record<string, string> = { Accept: raw ? remote.provider === "github" ? "application/vnd.github.diff" : "text/plain" : "application/json", "User-Agent": "Rack-Desktop", "Content-Type": "application/json" };
    if (token) headers[remote.provider === "gitlab" ? "PRIVATE-TOKEN" : "Authorization"] = remote.provider === "gitlab" ? token : `Bearer ${token}`;
    let response: Response | undefined;
    for (let redirect = 0; redirect < 4; redirect++) {
      response = await this.fetcher(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000), redirect: "manual" });
      if (![301, 302, 307, 308].includes(response.status)) break;
      const next = new URL(response.headers.get("location") ?? "", url);
      if (next.origin !== url.origin || next.href === url.href) throw new Error("The provider redirected outside its API. Check the remote configuration.");
      await response.body?.cancel();
      url = next;
    }
    if (!response?.ok) {
      await response?.body?.cancel();
      const status = response?.status;
      throw new Error(status === 401 || status === 403 ? `Access denied by ${remote.provider}. Connect an account with repository and pull request permissions, or check the API rate limit.`
        : status === 409 || status === 405 ? "The PR changed or cannot be merged. Refresh and check required reviews and checks."
          : `The provider rejected this request (HTTP ${status}). Check branches, permissions and repository rules.`);
    }
    if (response.status === 204) return {};
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) { await reader.cancel(); throw new Error("Provider response exceeds the 2 MB review limit. Narrow the search or open this PR on its code host."); }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return raw ? text : text ? JSON.parse(text) : {};
  }
  async list(path: string, name: string, query: string, state: PullState, page: number): Promise<PullList> {
    return this.listRemote(await this.remote(path, name), query, state, page);
  }
  /** Repository-wide queries can also be routed through an explicitly chosen GitHub account. */
  async listRemote(remote: Remote, query: string, state: PullState, page: number): Promise<PullList> {
    const root = this.root(remote);
    let data: any;
    const needle = query.trim();
    if (remote.provider === "github") {
      if (needle || state === "merged") {
        const safeQuery = needle.replace(/(?:repo|org|user|is|state|type):\S+/gi, "");
        const terms = `repo:${remote.slug} is:pr ${state === "all" ? "" : state === "merged" ? "is:merged" : state === "closed" ? "is:closed -is:merged" : "is:open"} ${safeQuery}`;
        data = await this.request(remote, `/search/issues?q=${enc(terms)}&sort=updated&order=desc&per_page=${PAGE_SIZE}&page=${page}`);
        const issues = data.items as Data[];
        // Search issues omit branch/commit data; detail is loaded only for the selected PR.
        return { items: issues.map((entry) => this.normalize(remote, { ...entry, merged_at: entry.pull_request?.merged_at })), hasMore: page * PAGE_SIZE < data.total_count && page * PAGE_SIZE < 1000 };
      }
      data = await this.request(remote, `${root}?state=${state === "closed" ? "closed" : state}&sort=updated&direction=desc&per_page=${PAGE_SIZE}&page=${page}`);
      // GitHub's closed endpoint also contains merged PRs; filter after normalization.
    } else if (remote.provider === "gitlab") {
      data = await this.request(remote, `${root}?scope=all&state=${state === "open" ? "opened" : state}&search=${enc(needle)}&order_by=updated_at&sort=desc&per_page=${PAGE_SIZE}&page=${page}`);
    } else {
      const stateQuery = state === "all" ? ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"].map((value) => `state=${value}`).join("&") : `state=${state === "open" ? "OPEN" : state === "merged" ? "MERGED" : "DECLINED"}`;
      data = await this.request(remote, `${root}?${stateQuery}&sort=-updated_on&pagelen=${PAGE_SIZE}&page=${page}${needle ? `&q=${enc(`title ~ ${JSON.stringify(needle)}`)}` : ""}`);
    }
    const values: Data[] = remote.provider === "bitbucket" ? data.values : data;
    const items = values.map((entry) => this.normalize(remote, entry)).filter((entry) => state === "all" || entry.state === state);
    return { items, hasMore: remote.provider === "bitbucket" ? Boolean(data.next) : values.length === PAGE_SIZE };
  }
  normalize(remote: Remote, data: Data): PullRequest {
    const github = remote.provider === "github", gitlab = remote.provider === "gitlab";
    return { id: Number(github ? data.number : gitlab ? data.iid : data.id), title: str(data.title), body: str(github ? data.body : data.description),
      url: str(github ? data.html_url : gitlab ? data.web_url : data.links?.html?.href), author: str(github ? data.user?.login : data.author?.username ?? data.author?.display_name),
      state: (data.merged_at || data.state === "merged" || data.state === "MERGED") ? "merged" : ["open", "opened", "OPEN"].includes(data.state) ? "open" : "closed",
      draft: Boolean(data.draft ?? data.work_in_progress), source: str(github ? data.head?.ref : gitlab ? data.source_branch : data.source?.branch?.name),
      ...(remote.provider === "bitbucket" && data.source?.repository?.full_name ? { sourceRepository: str(data.source.repository.full_name) } : {}),
      target: str(github ? data.base?.ref : gitlab ? data.target_branch : data.destination?.branch?.name),
      head: str(github ? data.head?.sha : gitlab ? data.diff_refs?.head_sha ?? data.sha : data.source?.commit?.hash),
      base: str(github ? data.base?.sha : gitlab ? data.diff_refs?.base_sha : data.destination?.commit?.hash),
      updatedAt: str(github || gitlab ? data.updated_at : data.updated_on) };
  }
  async detail(path: string, name: string, id: number): Promise<PullDetail> {
    return this.detailRemote(await this.remote(path, name), id, path);
  }
  /** Shared provider reader; account inboxes may omit a local checkout entirely. */
  async detailRemote(remote: Remote, id: number, path?: string): Promise<PullDetail> {
    const root = `${this.root(remote)}/${id}`;
    const rawPull = await this.request(remote, root);
    const pull = this.normalize(remote, rawPull);
    const comments: ReviewComment[] = [];
    let diff = "", truncated = false;
    if (remote.provider === "github") {
      const [patch, discussion, reviews, inline] = await Promise.all([this.request(remote, root, "GET", undefined, undefined, true),
        this.request(remote, `/repos/${remote.slug}/issues/${id}/comments?per_page=100`), this.request(remote, `${root}/reviews?per_page=100`), this.request(remote, `${root}/comments?per_page=100`)]);
      diff = patch;
      for (const entry of [...discussion, ...reviews] as Data[]) comments.push({ author: str(entry.user?.login), body: `${entry.state ? `[${entry.state}]\n` : ""}${str(entry.body)}`, createdAt: str(entry.created_at ?? entry.submitted_at) });
      for (const entry of inline as Data[]) comments.push({ author: str(entry.user?.login), body: `${entry.path ? `[${entry.path}${entry.line ? `:${entry.line}` : ""}]\n` : ""}${str(entry.body)}`, createdAt: str(entry.created_at) });
      truncated = discussion.length === 100 || reviews.length === 100 || inline.length === 100;
    } else if (remote.provider === "gitlab") {
      const [patches, discussion] = await Promise.all([this.request(remote, `${root}/diffs?per_page=100`), this.request(remote, `${root}/notes?per_page=100&sort=asc`)]);
      diff = (patches as Data[]).map((entry) => `diff --git a/${entry.old_path} b/${entry.new_path}\n--- a/${entry.old_path}\n+++ b/${entry.new_path}\n${entry.diff}`).join("\n");
      for (const entry of discussion as Data[]) comments.push({ author: str(entry.author?.username), body: str(entry.body), createdAt: str(entry.created_at) });
      truncated = patches.length === 100 || discussion.length === 100 || patches.some((entry: Data) => entry.collapsed || entry.too_large);
    } else {
      const [patch, discussion] = await Promise.all([this.request(remote, `${root}/diff`, "GET", undefined, undefined, true), this.request(remote, `${root}/comments?pagelen=100&sort=created_on`)]);
      diff = patch;
      for (const entry of discussion.values as Data[]) comments.push({ author: str(entry.user?.display_name), body: str(entry.content?.raw), createdAt: str(entry.created_on) });
      truncated = Boolean(discussion.next);
    }
    const checks: ReviewCheck[] = [];
    let checksNotice: string | undefined;
    try {
      if (remote.provider === "github") {
        const [runs, status] = await Promise.all([this.request(remote, `/repos/${remote.slug}/commits/${pull.head}/check-runs?per_page=100`), this.request(remote, `/repos/${remote.slug}/commits/${pull.head}/status?per_page=100`)]);
        for (const entry of Array.isArray(runs.check_runs) ? runs.check_runs : []) checks.push({ name: str(entry.name), status: str(entry.conclusion ?? entry.status), url: str(entry.html_url ?? entry.details_url) });
        for (const entry of Array.isArray(status.statuses) ? status.statuses : []) checks.push({ name: str(entry.context), status: str(entry.state), url: str(entry.target_url) });
        if (runs.total_count > 100 || status.statuses?.length === 100) checksNotice = "Check results are shortened; open the code host for all checks.";
      } else if (remote.provider === "gitlab") {
        const pipeline = rawPull.head_pipeline;
        if (pipeline) checks.push({ name: "Head pipeline", status: str(pipeline.status), url: str(pipeline.web_url) });
      } else {
        const result = await this.request(remote, `/repositories/${remote.slug}/commit/${pull.head}/statuses?pagelen=100`);
        for (const entry of Array.isArray(result.values) ? result.values : []) checks.push({ name: str(entry.name ?? entry.key), status: str(entry.state).toLowerCase(), url: str(entry.url) });
        if (result.next) checksNotice = "Check results are shortened; open the code host for all checks.";
      }
    } catch { checksNotice = "Checks could not be loaded. Check repository access or open the code host."; }
    const saved = path ? await savedReview(path, remote, id) : undefined;
    let timelineCheckpointId = saved?.checkpointId, timelineError: string | undefined;
    if (path && saved && (saved.head !== pull.head || saved.base !== pull.base)) {
      try { timelineCheckpointId = await syncReview(path, remote, pull); }
      catch { timelineError = "New PR commits could not sync to Timeline. Check Git access, then use View in Timeline to retry."; }
    }
    return { pull, diff, checks, ...(checksNotice ? { checksNotice } : {}), comments: comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt)), truncated,
      ...(timelineCheckpointId ? { timelineCheckpointId } : {}), ...(timelineError ? { timelineError } : {}) };
  }
  async create(path: string, name: string, input: CreatePull): Promise<PullRequest> {
    return this.createRemote(await this.remote(path, name), input);
  }
  async createRemote(remote: Remote, input: CreatePull): Promise<PullRequest> {
    const body = remote.provider === "github" ? { title: input.title, body: input.body, head: input.source, base: input.target, draft: input.draft }
      : remote.provider === "gitlab" ? { title: input.draft ? `Draft: ${input.title}` : input.title, description: input.body, source_branch: input.source, target_branch: input.target }
        : { title: input.title, description: input.body, source: { branch: { name: input.source } }, destination: { branch: { name: input.target } }, draft: input.draft };
    return this.normalize(remote, await this.request(remote, this.root(remote), "POST", body));
  }
  async act(path: string, name: string, id: number, action: ReviewAction, body: string, head: string): Promise<void> {
    return this.actRemote(await this.remote(path, name), id, action, body, head);
  }
  /** Refresh and mutate through the exact credential bound by the calling adapter. */
  async actRemote(remote: Remote, id: number, action: ReviewAction, body: string, head: string): Promise<void> {
    const root = `${this.root(remote)}/${id}`;
    if (!/^[a-f\d]{40,64}$/i.test(head)) throw new Error("Refresh this PR before submitting a review.");
    if (["comment", "request_changes"].includes(action) && !body.trim()) throw new Error("A review comment is required.");
    // Refresh before destructive remote actions; GitHub/GitLab also atomically guard the SHA.
    const current = this.normalize(remote, await this.request(remote, root));
    if (current.head !== head) throw new Error("New commits were pushed. Refresh and review the latest changes before submitting.");
    if (remote.provider === "github") {
      if (action === "merge") await this.request(remote, `${root}/merge`, "PUT", { sha: head });
      else if (action === "close" || action === "reopen") await this.request(remote, root, "PATCH", { state: action === "close" ? "closed" : "open" });
      else await this.request(remote, `${root}/reviews`, "POST", { body, commit_id: head, event: action === "approve" ? "APPROVE" : action === "request_changes" ? "REQUEST_CHANGES" : "COMMENT" });
    } else if (remote.provider === "gitlab") {
      if (action === "merge") await this.request(remote, `${root}/merge`, "PUT", { sha: head });
      else if (action === "close" || action === "reopen") await this.request(remote, root, "PUT", { state_event: action === "close" ? "close" : "reopen" });
      else if (action === "approve") {
        if (body.trim()) await this.request(remote, `${root}/notes`, "POST", { body });
        await this.request(remote, `${root}/approve`, "POST", { sha: head });
      } else {
        // Request-changes is not a portable GitLab API review state. Report support explicitly.
        if (action === "request_changes") throw new Error("GitLab review blocking depends on server version and rules. Use a comment or request changes on GitLab.");
        await this.request(remote, `${root}/notes`, "POST", { body });
      }
    } else {
      if (action === "reopen") throw new Error("Bitbucket Cloud does not support reopening a declined PR through this API. Create a new PR instead.");
      if (["merge", "close"].includes(action)) await this.request(remote, `${root}/${action === "merge" ? "merge" : "decline"}`, "POST", {});
      else {
        if (body.trim()) await this.request(remote, `${root}/comments`, "POST", { content: { raw: body } });
        if (action !== "comment") await this.request(remote, `${root}/${action === "approve" ? "approve" : "request-changes"}`, "POST", {});
      }
    }
  }
  async publish(path: string, name: string, branch: string): Promise<void> {
    await this.remote(path, name);
    await git(path, ["check-ref-format", "--branch", branch]);
    await git(path, ["push", "--set-upstream", "--", name, `refs/heads/${branch}:refs/heads/${branch}`]);
  }
  async sync(path: string, name: string, id: number): Promise<string> {
    const remote = await this.remote(path, name);
    const pull = this.normalize(remote, await this.request(remote, `${this.root(remote)}/${id}`));
    return syncReview(path, remote, pull);
  }
}
