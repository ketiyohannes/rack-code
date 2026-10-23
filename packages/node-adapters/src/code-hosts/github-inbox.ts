/** GitHub search fans out across explicit accounts; repository checkouts are optional. */
import type { InboxPull, InboxQuery, InboxResult, InboxTarget, RepositoryTarget, ReviewInboxGateway } from "@rack/features/pull-requests";
import type { CreatePull, PullState, ReviewAction } from "@rack/features/pull-requests";
import { GitHubAccounts, githubRemote } from "./github-accounts.js";
import { RestCodeHosts } from "./rest.js";
import { remotes } from "./repository.js";
const PAGE_SIZE = 50;
const RETRY_DELAY_MS = 1000;
/** Runs `operation`, retrying once after a short delay; the second failure propagates. */
async function retryOnce<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return operation();
  }
}
export class GitHubInbox implements ReviewInboxGateway {
  constructor(private readonly identities = new GitHubAccounts(), private readonly fetcher: typeof fetch = fetch) {}
  accounts(refresh: boolean) { return this.identities.accounts(refresh); }
  beginLogin(host: string) { return this.identities.beginLogin(host); }
  finishLogin(loginId: string) { return this.identities.finishLogin(loginId); }
  cancelLogin(loginId: string) { this.identities.cancelLogin(loginId); }
  cancelLogins() { this.identities.cancelLogins(); }
  private async client(target: RepositoryTarget, name?: string) {
    const account = await this.identities.account(target.accountId);
    const remote = githubRemote(account.host, target.repository, name);
    // Snapshot the selected credential once for the complete read/mutation, including all subrequests.
    const token = await this.identities.token(account.id);
    return { remote, client: new RestCodeHosts(this.fetcher, async () => token) };
  }
  async list(query: InboxQuery): Promise<InboxResult> {
    const catalog = await this.accounts(false);
    const accounts = query.accountId ? catalog.accounts.filter((entry) => entry.id === query.accountId) : catalog.accounts;
    if (query.accountId && !accounts.length) throw new Error("The selected GitHub account is no longer connected.");
    const items = new Map<string, InboxPull>(), notices = [...catalog.notices];
    let hasMore = false, failed = 0;
    // Keep account ordering deterministic when merging duplicates. Concurrent results are folded only
    // after settlement, so overlapping PRs keep the same default account across refreshes.
    for (let offset = 0; offset < accounts.length; offset += 4) {
      const batch = accounts.slice(offset, offset + 4);
      // One delayed retry per account absorbs transient failures (first keychain read, GitHub's
      // secondary search rate limit) before the account is reported as unavailable.
      const results = await Promise.allSettled(batch.map((account) => retryOnce(async () => {
        const { client, remote } = await this.client({ accountId: account.id, repository: "owner/repo" });
        const relation = query.involvement === "created" ? "author" : query.involvement === "assigned" ? "assignee" : query.involvement === "review_requested" ? "review-requested" : "involves";
        const state = query.state === "all" ? "" : query.state === "closed" ? "is:closed -is:merged" : `is:${query.state}`;
        // Search is plain text (or a PR number); users cannot accidentally override the account/state scope.
        const needle = query.query.trim().replace(/^#(?=\d+$)/, "");
        // Keep already-reviewed PRs after GitHub removes their pending review request.
        const relations = query.involvement === "involved" ? ["involves", "review-requested", "reviewed-by"] : [relation];
        const responses = await Promise.all(relations.map(async (qualifier) => {
          const terms = `is:pr ${qualifier}:${account.login} ${state}${needle ? ` ${JSON.stringify(needle)}` : ""}`;
          return client.request(remote, `/search/issues?q=${encodeURIComponent(terms)}&sort=updated&order=desc&per_page=${PAGE_SIZE}&page=${query.page}`);
        }));
        const data = { items: responses.flatMap((result) => result.items ?? []), total_count: Math.max(...responses.map((result) => Number(result.total_count))), incomplete_results: responses.some((result) => result.incomplete_results) };
        if (!Array.isArray(data.items)) throw new Error("GitHub returned an invalid pull request list.");
        const pulls: InboxPull[] = [];
        for (const entry of data.items) {
          // Derive owner/name from the API repository URL, never from a title or arbitrary external link.
          const url = new URL(String(entry.repository_url));
          if (url.origin !== new URL(remote.api).origin) throw new Error("GitHub returned a repository on a different host.");
          const prefix = new URL(remote.api).pathname.replace(/\/$/, "") + "/repos/";
          if (!url.pathname.startsWith(prefix)) throw new Error("GitHub returned an invalid repository URL.");
          const repository = url.pathname.slice(prefix.length);
          const repo = githubRemote(account.host, repository);
          if (!Number.isSafeInteger(entry.number) || entry.number < 1) throw new Error("GitHub returned an invalid PR number.");
          pulls.push({ ...client.normalize(repo, { ...entry, merged_at: entry.pull_request?.merged_at }), host: account.host, repository, accounts: [account.id] });
        }
        return { pulls, total: Number(data.total_count), incomplete: Boolean(data.incomplete_results) };
      })));
      for (let index = 0; index < results.length; index++) {
        const account = batch[index]!, result = results[index]!;
        if (result.status === "rejected") { failed++; notices.push(`${account.login} · ${account.host}: Pull requests could not be loaded. Refresh, or sign in to this account again.`); continue; }
        const { pulls, total, incomplete } = result.value;
        hasMore ||= query.page * PAGE_SIZE < Math.min(total, 1000);
        if (total > 1000) notices.push(`${account.login}: GitHub search is limited to 1,000 results. Narrow the search or status to see older PRs.`);
        if (incomplete) notices.push(`${account.login}: GitHub returned incomplete search results. Refresh to retry.`);
        for (const pull of pulls) {
          const key = `${pull.host}/${pull.repository.toLowerCase()}#${pull.id}`, previous = items.get(key);
          items.set(key, previous ? { ...previous, accounts: [...new Set([...previous.accounts, ...pull.accounts])] } : pull);
        }
      }
    }
    return { items: [...items.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || `${a.host}/${a.repository}#${a.id}`.localeCompare(`${b.host}/${b.repository}#${b.id}`)), hasMore, notices: [...new Set(notices)], unavailable: accounts.length > 0 && failed === accounts.length };
  }
  async repositoryList(target: RepositoryTarget, query: string, state: PullState, page: number) {
    const { client, remote } = await this.client(target);
    return client.listRemote(remote, query, state, page);
  }
  async create(target: RepositoryTarget, input: CreatePull) {
    const { client, remote } = await this.client(target);
    return client.createRemote(remote, input);
  }
  async local(path: string, target: InboxTarget): Promise<string | undefined> {
    const account = await this.identities.account(target.accountId);
    try { return (await remotes(path)).find((entry) => entry.provider === "github" && entry.host === account.host && entry.slug.toLowerCase() === target.repository.toLowerCase())?.name; }
    catch { return undefined; } // Deleted/unavailable saved folders must not hide remote reviews.
  }
  async detail(target: InboxTarget, local?: { path: string; remote: string }) {
    const { client, remote } = await this.client(target, local?.remote);
    return client.detailRemote(remote, target.id, local?.path);
  }
  async act(target: InboxTarget, action: ReviewAction, body: string, head: string): Promise<void> {
    const { client, remote } = await this.client(target);
    return client.actRemote(remote, target.id, action, body, head);
  }
  async sync(target: InboxTarget, path: string, name: string): Promise<string> {
    // The client is bound to the selected account, so the Git fetch authenticates as that account too.
    const { client, remote } = await this.client(target, name);
    return client.syncRemote(path, remote, target.id);
  }
}
