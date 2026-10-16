/** Multi-account fixtures never inspect real credentials or mutate a hosted repository. */
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubAccounts, githubRemote, type GitHubCli } from "./github-accounts.js";
import { GitHubInbox } from "./github-inbox.js";
import { ReviewInboxService } from "../../features/pull-requests/index.js";
import { validateCommandParams } from "../../contracts/desktop/commands.js";
const head = "b".repeat(40), base = "a".repeat(40);
const pull = (repository: string, id: number, date = "2026-10-16T10:00:00Z") => ({ number: id, title: `${repository} #${id}`, body: "Details", state: "open", user: { login: "alice" }, html_url: `https://github.com/${repository}/pull/${id}`, repository_url: `https://api.github.com/repos/${repository}`, head: { ref: "feature", sha: head }, base: { ref: "main", sha: base }, updated_at: date });
const auth = (options?: RequestInit) => (options?.headers as Record<string, string>)?.Authorization;
const cliLogins: GitHubCli = async (args, env) => {
  assert.equal(env.GH_TOKEN, undefined); assert.equal(env.GITHUB_TOKEN, undefined); assert.equal(env.GH_ENTERPRISE_TOKEN, undefined); assert.equal(env.GH_HOST, undefined);
  assert.equal(env.GH_CONFIG_DIR, "/test/config");
  if (args[1] === "status") {
    assert.deepEqual(args, ["auth", "status", "--json", "hosts"]);
    return JSON.stringify({ hosts: { "github.com": [{ account: "alice", active: true }, { account: "bob", active: false }], "git.example.com": [{ account: "work", active: true }] } });
  }
  assert.equal(args[1], "token"); assert.equal(args[4], "--user");
  return `secret-${args[5]}`;
};

test("discovers all CLI users and enterprise hosts, deduplicates env identities, and never switches gh login", async () => {
  const calls: string[][] = [];
  const accounts = new GitHubAccounts(async (_url, options) => Response.json({ login: auth(options) === "Bearer env-alice" ? "Alice" : "work" }), async (args, env) => {
    calls.push([...args]); return cliLogins(args, env);
  }, { GH_TOKEN: "env-alice", GH_ENTERPRISE_TOKEN: "env-work", GH_HOST: "git.example.com", GH_CONFIG_DIR: "/test/config" });
  const catalog = await accounts.accounts();
  assert.equal(catalog.accounts.length, 3);
  assert.equal(catalog.accounts.find((a) => a.login === "Alice")?.source, "environment");
  assert.equal(await accounts.token("github:github.com:alice"), "env-alice");
  assert.equal(await accounts.token("github:github.com:bob"), "secret-bob");
  assert.equal(await accounts.token("github:git.example.com:work"), "env-work");
  assert.equal(calls.length, 2); // status plus the inactive bob token; no global auth switch.
  assert.doesNotMatch(JSON.stringify(catalog), /secret-|env-alice|env-work/);
  assert.deepEqual(catalog.notices, []);
});

test("inbox merges shared PRs, keeps equal PR numbers in different repositories, sorts, and paginates all accounts", async () => {
  const calls: { token: string | undefined; query: string; page: string | null }[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input)), query = url.searchParams.get("q") ?? "", token = auth(options);
    calls.push({ token, query, page: url.searchParams.get("page") });
    const bob = token === "Bearer secret-bob";
    return Response.json({ items: [{ ...pull("team/shared", 7), repository_url: `${url.origin}${url.pathname.startsWith("/api/v3") ? "/api/v3" : ""}/repos/team/shared` }, ...(bob ? [pull("org/other", 7, "2026-10-16T11:00:00Z")] : [])], total_count: bob ? 120 : 1 });
  };
  const accounts = new GitHubAccounts(fetcher, cliLogins, { GH_CONFIG_DIR: "/test/config" });
  const inbox = new GitHubInbox(accounts, fetcher);
  const result = await inbox.list({ involvement: "involved", query: "", state: "open", page: 1 });
  assert.equal(result.items.length, 3); // Enterprise PR has a distinct host, even with the same slug/number.
  const shared = result.items.find((entry) => entry.repository === "team/shared" && entry.host === "github.com")!;
  assert.deepEqual(shared.accounts, ["github:github.com:alice", "github:github.com:bob"]);
  assert.equal(result.items[0]?.repository, "org/other"); assert.equal(result.hasMore, true);
  assert.equal(calls.length, 9); // involvement, pending requests and already-submitted reviews for each account.
  assert.ok(calls.some((call) => call.query.includes("review-requested:bob")));
  assert.ok(calls.some((call) => call.query.includes("reviewed-by:bob")));
  calls.length = 0;
  await inbox.list({ accountId: "github:github.com:bob", involvement: "created", query: "#7", state: "closed", page: 2 });
  assert.equal(calls.length, 1); assert.match(calls[0]!.query, /author:bob is:closed -is:merged "7"/); assert.equal(calls[0]!.page, "2");
});

test("a failed account cannot hide another account's PRs, and failures never expose tokens", async () => {
  const fetcher: typeof fetch = async (_input, options) => auth(options) === "Bearer secret-bob" ? Response.json({ items: [pull("team/repo", 3)], total_count: 1 }) : new Response("secret-alice", { status: 401 });
  const inbox = new GitHubInbox(new GitHubAccounts(fetcher, cliLogins, { GH_CONFIG_DIR: "/test/config" }), fetcher);
  const result = await inbox.list({ involvement: "created", query: "", state: "all", page: 1 });
  assert.equal(result.items.length, 1); assert.equal(result.notices.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /secret-/);
  await assert.rejects(inbox.list({ accountId: "missing", involvement: "created", query: "", state: "all", page: 1 }), /no longer connected/);
});

test("details, reviews and creation use the selected inactive account without a local checkout", async () => {
  const calls: { path: string; method: string; body: any }[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input)); assert.equal(auth(options), "Bearer secret-bob");
    const method = options?.method ?? "GET";
    calls.push({ path: url.pathname, method, body: options?.body ? JSON.parse(String(options.body)) : undefined });
    if ((options?.headers as Record<string, string>).Accept?.includes("diff")) return new Response("diff --git a/a b/a\n-old\n+new");
    if (url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: [] });
    if (url.pathname.endsWith("/status")) return Response.json({ statuses: [] });
    if (url.pathname.endsWith("/comments") || url.pathname.endsWith("/reviews")) return Response.json([]);
    return Response.json(pull("team/repo", 7));
  };
  const inbox = new ReviewInboxService(new GitHubInbox(new GitHubAccounts(fetcher, cliLogins, { GH_CONFIG_DIR: "/test/config" }), fetcher), async () => []);
  const target = { accountId: "github:github.com:bob", repository: "team/repo", id: 7 };
  const detail = await inbox.detail(target);
  assert.equal(detail.local, undefined); assert.equal(detail.pull.head, head); assert.match(detail.diff, /new/);
  await inbox.act(target, "approve", "Looks good", head);
  assert.equal(calls.find((call) => call.method === "POST")?.body.event, "APPROVE");
  await inbox.act(target, "merge", "", head);
  assert.equal(calls.find((call) => call.method === "PUT")?.body.sha, head);
  await assert.rejects(inbox.act(target, "merge", "", base), /New commits/);
  await inbox.create(target, { title: "New", body: "Why", source: "feature", target: "main", draft: true });
  assert.ok(calls.some((call) => call.path.endsWith("/pulls") && call.body.draft));
  await assert.rejects(inbox.create(target, { title: "New", body: "", source: "main", target: "main", draft: false }), /different source/);
  await assert.rejects(inbox.sync(target), /local folder/);
});

test("expired selected credentials never fall back to the active account or environment", async () => {
  let fetches = 0;
  const accounts = new GitHubAccounts(async () => { fetches++; return Response.json({}); }, async (args) => {
    if (args[1] === "status") return JSON.stringify({ hosts: { "github.com": [{ account: "alice" }, { account: "bob" }] } });
    if (args[5] === "bob") throw new Error("token secret-bob expired");
    return "secret-alice";
  }, {});
  const inbox = new GitHubInbox(accounts, async () => { fetches++; return Response.json({}); });
  await assert.rejects(inbox.detail({ accountId: "github:github.com:bob", repository: "team/repo", id: 7 }), /Reconnect bob/);
  assert.equal(fetches, 0);
});

test("manual connections bind identity via /user, reject bad replacements and keep tokens out of views", async () => {
  const accounts = new GitHubAccounts(async (_url, options) => auth(options) === "Bearer invalid" ? new Response("bad-token", { status: 401 }) : Response.json({ login: auth(options) === "Bearer alice-token" ? "alice" : "bob" }), async () => { throw new Error("no gh"); }, {});
  const alice = await accounts.connect("github.com", "alice-token"), bob = await accounts.connect("github.com", "bob-token");
  assert.notEqual(alice.id, bob.id); assert.equal((await accounts.accounts()).accounts.length, 2);
  await assert.rejects(accounts.connect("github.com", "invalid"), /Access denied/);
  assert.equal(await accounts.token(alice.id), "alice-token"); assert.equal(await accounts.token(bob.id), "bob-token");
  assert.doesNotMatch(JSON.stringify(await accounts.accounts()), /alice-token|bob-token|bad-token/);
});

test("repository identities and API redirects cannot send account credentials to an unrelated host", async () => {
  assert.throws(() => githubRemote("github.com/evil", "team/repo"), /hostname/);
  for (const repository of ["../repo", "team/../repo", "team/repo?token=x", "team/repo#fragment", "team/%2e%2e", "team/repo/third"]) assert.throws(() => githubRemote("github.com", repository), /repository/);
  const fetcher: typeof fetch = async () => Response.json({ items: [{ ...pull("team/repo", 7), repository_url: "https://evil.example/repos/team/repo" }], total_count: 1 });
  const inbox = new GitHubInbox(new GitHubAccounts(fetcher, cliLogins, { GH_CONFIG_DIR: "/test/config" }), fetcher);
  const result = await inbox.list({ involvement: "created", query: "", state: "open", page: 1 });
  assert.equal(result.items.length, 0); assert.equal(result.notices.length, 3);
});

test("desktop inbox commands bound inputs and preserve explicit account identity", () => {
  assert.deepEqual(validateCommandParams("reviews.inboxDetail", { accountId: "a", repository: "owner/repo", id: 3 }), { accountId: "a", repository: "owner/repo", id: 3 });
  assert.throws(() => validateCommandParams("reviews.inboxDetail", { repository: "owner/repo", id: 3 }));
  assert.throws(() => validateCommandParams("reviews.inbox", { involvement: "involved", query: "", state: "all", page: 21 }));
  assert.throws(() => validateCommandParams("reviews.accountConnect", { host: "github.com", token: "x".repeat(4097) }));
});

test("Timeline resolves only matching saved folders and honors an explicitly chosen project", async () => {
  const inbox = new GitHubInbox(new GitHubAccounts(undefined, cliLogins, { GH_CONFIG_DIR: "/test/config" }));
  const probes: string[] = [], syncs: string[] = [];
  // Substitute the Git boundary; service routing still uses real account-wide workflow rules.
  inbox.local = async (path) => { probes.push(path); return path.startsWith("/matching/") ? "upstream" : undefined; };
  inbox.sync = async (_target, path, remote) => { syncs.push(`${path}/${remote}`); return "checkpoint:review"; };
  const service = new ReviewInboxService(inbox, async () => [{ id: "other", path: "/other" }, { id: "first", path: "/matching/first" }, { id: "second", path: "/matching/second" }]);
  const target = { accountId: "github:github.com:bob", repository: "team/repo", id: 7 };
  assert.deepEqual(await service.sync(target, "second"), { projectId: "second", checkpointId: "checkpoint:review" });
  assert.deepEqual(probes, ["/matching/second"]); assert.deepEqual(syncs, ["/matching/second/upstream"]);
  await assert.rejects(service.sync(target, "other"), /local folder/);
  await assert.rejects(service.sync(target, "unknown-project"), /local folder/);
  assert.equal(syncs.length, 1);
});

test("search windows and incomplete results are disclosed, and all-account failure is not an empty inbox", async () => {
  let fail = false;
  const fetcher: typeof fetch = async () => fail ? new Response(null, { status: 403 }) : Response.json({ items: [pull("team/repo", 7)], total_count: 1400, incomplete_results: true });
  const inbox = new GitHubInbox(new GitHubAccounts(fetcher, cliLogins, { GH_CONFIG_DIR: "/test/config" }), fetcher);
  const query = { accountId: "github:github.com:alice", involvement: "review_requested" as const, query: "", state: "open" as const, page: 20 };
  const result = await inbox.list(query);
  assert.equal(result.hasMore, false); assert.equal(result.unavailable, false);
  assert.match(result.notices.join(" "), /1,000/); assert.match(result.notices.join(" "), /incomplete/);
  fail = true;
  const unavailable = await inbox.list(query);
  assert.equal(unavailable.unavailable, true); assert.equal(unavailable.items.length, 0);
});
