/** REST translation for GitHub, GitLab and Bitbucket Cloud, shared by repository and account workflows. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CreatePull, PullDetail, PullList, PullRequest, PullRequestGateway, PullState, ReviewAction, ReviewCheck, ReviewComment, ReviewFile, ReviewRepository } from "../../features/pull-requests/index.js";
import { git, remotes, savedReview, syncReview, type Remote } from "./repository.js";
const exec = promisify(execFile);
type Data = Record<string, any>;
const enc = encodeURIComponent;
const PAGE_SIZE = 50;
/** GitHub's file listing: 30 per page keeps each page well under MAX_BYTES; 10 pages = 300 files. */
const FILE_PAGE_SIZE = 30, MAX_FILE_PAGES = 10;
const MAX_BYTES = 2_000_000;
const str = (value: unknown): string => typeof value === "string" ? value : "";

/** A non-2xx provider reply; `status` lets callers handle specific codes without parsing messages. */
class ProviderHttpError extends Error {
  constructor(message: string, readonly status: number | undefined) { super(message); }
}
/** Thrown when a body passes MAX_BYTES; text responses keep the bytes read so far. */
class OversizedResponse extends Error {
  constructor(readonly partial: string) { super("Provider response exceeds the 2 MB review limit. Narrow the search or open this PR on its code host."); }
}
/**
 * Keeps only complete files from a cut-off unified diff: everything before the
 * last `diff --git` header that started inside the limit. A diff with a single
 * oversized file keeps the bytes up to the last complete line.
 */
function wholeFiles(partial: string): string {
  const boundary = partial.lastIndexOf("\ndiff --git ");
  if (boundary > 0) return partial.slice(0, boundary + 1);
  const line = partial.lastIndexOf("\n");
  return line > 0 ? partial.slice(0, line + 1) : "";
}

/** GitHub review states shown in Activity; PENDING (an unsubmitted draft) and unknown values are omitted. */
function reviewState(value: unknown): ReviewComment["state"] | undefined {
  switch (value) {
    case "APPROVED": return "approved";
    case "CHANGES_REQUESTED": return "changes_requested";
    case "COMMENTED": return "commented";
    case "DISMISSED": return "dismissed";
    default: return undefined;
  }
}

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
      throw new ProviderHttpError(status === 401 || status === 403 ? `Access denied by ${remote.provider}. Connect an account with repository and pull request permissions, or check the API rate limit.`
        : status === 409 || status === 405 ? "The PR changed or cannot be merged. Refresh and check required reviews and checks."
          : `The provider rejected this request (HTTP ${status}). Check branches, permissions and repository rules.`, status);
    }
    if (response.status === 204) return {};
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) {
        await reader.cancel();
        // Keep the in-limit part of the final chunk too: a body can arrive as one large chunk.
        if (raw) chunks.push(value.subarray(0, value.byteLength - (length - MAX_BYTES)));
        throw new OversizedResponse(raw ? Buffer.concat(chunks).toString("utf8") : "");
      }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return raw ? text : text ? JSON.parse(text) : {};
  }
  /**
   * Reads a unified diff for review. Large PRs must stay reviewable, so a diff
   * over the size limit is cut to whole files, and GitHub's "diff too large"
   * reply (HTTP 406) yields an empty diff; both report `truncated`. Other
   * failures propagate.
   */
  private async diff(remote: Remote, path: string): Promise<{ text: string; truncated: boolean }> {
    try { return { text: await this.request(remote, path, "GET", undefined, undefined, true), truncated: false }; }
    catch (error) {
      if (error instanceof OversizedResponse) return { text: wholeFiles(error.partial), truncated: true };
      if (error instanceof ProviderHttpError && error.status === 406) return { text: "", truncated: true };
      throw error;
    }
  }
  /**
   * GitHub's per-file listing. Unlike the raw diff it stays small when a PR
   * contains generated or vendored files: GitHub omits those patches but still
   * reports the file and its counts. Paging stops at the last page, at
   * MAX_FILE_PAGES, or at a page over MAX_BYTES; `truncated` reports any gap.
   */
  private async githubFiles(remote: Remote, root: string, expected: number): Promise<{ files: ReviewFile[]; truncated: boolean }> {
    const files: ReviewFile[] = [];
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      let entries: Data[];
      try { entries = await this.request(remote, `${root}/files?per_page=${FILE_PAGE_SIZE}&page=${page}`); }
      catch (error) { if (error instanceof OversizedResponse && files.length) break; throw error; }
      if (!Array.isArray(entries)) break;
      for (const entry of entries) {
        const status = entry.status === "added" || entry.status === "removed" || entry.status === "renamed" ? entry.status : "modified";
        files.push({ path: str(entry.filename), status, additions: Number(entry.additions) || 0, deletions: Number(entry.deletions) || 0,
          ...(str(entry.previous_filename) ? { previousPath: str(entry.previous_filename) } : {}), ...(typeof entry.patch === "string" ? { patch: entry.patch } : {}) });
      }
      if (entries.length < FILE_PAGE_SIZE) break;
    }
    // Files without a patch are labelled individually in the Code tab, not as a shortened review.
    return { files, truncated: files.length < expected };
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
    let diff = "", truncated = false, files: ReviewFile[] | undefined;
    if (remote.provider === "github") {
      const [changed, discussion, reviews, inline] = await Promise.all([this.githubFiles(remote, root, Number(rawPull.changed_files) || 0),
        this.request(remote, `/repos/${remote.slug}/issues/${id}/comments?per_page=100`), this.request(remote, `${root}/reviews?per_page=100`), this.request(remote, `${root}/comments?per_page=100`)]);
      files = changed.files;
      for (const entry of discussion as Data[]) comments.push({ kind: "comment", author: str(entry.user?.login), body: str(entry.body), createdAt: str(entry.created_at) });
      for (const entry of reviews as Data[]) {
        const state = reviewState(entry.state);
        // A "commented" review with no body only groups inline comments, which are listed
        // individually; pending reviews are unsubmitted drafts.
        if (!state || (state === "commented" && !str(entry.body).trim())) continue;
        comments.push({ kind: "review", state, author: str(entry.user?.login), body: str(entry.body), createdAt: str(entry.submitted_at ?? entry.created_at) });
      }
      for (const entry of inline as Data[]) {
        const line = Number(entry.line ?? entry.original_line);
        comments.push({ kind: "inline", author: str(entry.user?.login), body: str(entry.body), createdAt: str(entry.created_at),
          ...(str(entry.path) ? { path: str(entry.path) } : {}), ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}) });
      }
      truncated = changed.truncated || discussion.length === 100 || reviews.length === 100 || inline.length === 100;
    } else if (remote.provider === "gitlab") {
      const [patches, discussion] = await Promise.all([this.request(remote, `${root}/diffs?per_page=100`), this.request(remote, `${root}/notes?per_page=100&sort=asc`)]);
      files = (patches as Data[]).map((entry) => {
        const patch = str(entry.diff), lines = patch.split("\n");
        return { path: str(entry.new_path), status: entry.new_file ? "added" : entry.deleted_file ? "removed" : entry.renamed_file ? "renamed" : "modified",
          additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length, deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
          ...(entry.renamed_file ? { previousPath: str(entry.old_path) } : {}), ...(patch ? { patch } : {}) } satisfies ReviewFile;
      });
      // System notes ("added 1 commit", label changes) are not discussion.
      for (const entry of discussion as Data[]) {
        if (entry.system) continue;
        const path = str(entry.position?.new_path ?? entry.position?.old_path), line = Number(entry.position?.new_line ?? entry.position?.old_line);
        comments.push({ kind: path ? "inline" : "comment", author: str(entry.author?.username), body: str(entry.body), createdAt: str(entry.created_at),
          ...(path ? { path } : {}), ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}) });
      }
      truncated = patches.length === 100 || discussion.length === 100 || patches.some((entry: Data) => entry.collapsed || entry.too_large);
    } else {
      const [patch, discussion] = await Promise.all([this.diff(remote, `${root}/diff`), this.request(remote, `${root}/comments?pagelen=100&sort=created_on`)]);
      diff = patch.text;
      for (const entry of discussion.values as Data[]) {
        const line = Number(entry.inline?.to ?? entry.inline?.from);
        comments.push({ kind: entry.inline ? "inline" : "comment", author: str(entry.user?.display_name), body: str(entry.content?.raw), createdAt: str(entry.created_on),
          ...(str(entry.inline?.path) ? { path: str(entry.inline.path) } : {}), ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}) });
      }
      truncated = patch.truncated || Boolean(discussion.next);
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
      try { timelineCheckpointId = await syncReview(path, remote, pull, await this.token(remote)); }
      catch { timelineError = "New PR commits could not sync to Timeline. Check Git access, then use View in Timeline to retry."; }
    }
    return { pull, diff, ...(files ? { files } : {}), checks, ...(checksNotice ? { checksNotice } : {}), comments: comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt)), truncated,
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
    return syncReview(path, remote, pull, await this.token(remote));
  }
  /** Timeline sync for a remote this client is bound to; fetches authenticate as its credential. */
  async syncRemote(path: string, remote: Remote, id: number): Promise<string> {
    const pull = this.normalize(remote, await this.request(remote, `${this.root(remote)}/${id}`));
    return syncReview(path, remote, pull, await this.token(remote));
  }
}
