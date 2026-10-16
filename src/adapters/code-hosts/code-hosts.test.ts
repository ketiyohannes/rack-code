/** Contract fixtures test real provider routes without posting to a user's repositories. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RestCodeHosts } from "./rest.js";
import { git, parseRemote, savedReview, syncReview, type Remote } from "./repository.js";
import { createApplication } from "../../composition/application.js";
import { validateCommandParams } from "../../contracts/desktop/commands.js";
const head = "b".repeat(40), base = "a".repeat(40);
const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after\n";
async function repository(remote: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rack-review-test-"));
  await git(path, ["init", "-b", "main"]); await git(path, ["remote", "add", "origin", remote]); return path;
}
const github = { number: 12, title: "Fix parser", body: "Why", state: "open", user: { login: "owner" }, html_url: "https://github.com/team/repo/pull/12", head: { ref: "fix/parser", sha: head }, base: { ref: "main", sha: base }, updated_at: "2026-10-16T10:00:00Z" };
const gitlab = { iid: 12, title: "Fix parser", description: "Why", state: "opened", author: { username: "owner" }, source_branch: "fix/parser", target_branch: "main", diff_refs: { head_sha: head, base_sha: base }, updated_at: "2026-10-16T10:00:00Z" };
const bitbucket = { id: 12, title: "Fix parser", description: "Why", state: "OPEN", author: { display_name: "owner" }, source: { branch: { name: "fix/parser" }, commit: { hash: head } }, destination: { branch: { name: "main" }, commit: { hash: base } }, updated_on: "2026-10-16T10:00:00Z" };

test("remote discovery recognizes SSH, HTTPS, nested GitLab and explicit enterprise hosts", () => {
  assert.equal(parseRemote("origin", "git@github.com:team/repo.git")?.slug, "team/repo");
  assert.equal(parseRemote("origin", "ssh://git@gitlab.com/team/sub/repo.git")?.slug, "team/sub/repo");
  assert.equal(parseRemote("upstream", "https://git.example.org/team/repo.git", "git.example.org=gitlab")?.api, "https://git.example.org/api/v4");
  for (const raw of ["file:///tmp/repo", "https://unknown.org/team/repo", "https://github.com/team", "ext::anything", "https://bitbucket.org/team/sub/repo"]) assert.equal(parseRemote("origin", raw), undefined);
});

for (const [provider, url, fixture] of [["github", "https://github.com/team/repo.git", github], ["gitlab", "git@gitlab.com:team/sub/repo.git", gitlab], ["bitbucket", "https://bitbucket.org/team/repo.git", bitbucket]] as const) {
  test(`${provider} supports list, detail, discussion, draft creation and review/merge routes`, async () => {
    const path = await repository(url);
    const calls: { url: URL; method: string; body: any; accept: string }[] = [];
    const fetcher: typeof fetch = async (input, options) => {
      const url = new URL(String(input)), method = options?.method ?? "GET", headers = options?.headers as Record<string, string>;
      calls.push({ url, method, body: options?.body ? JSON.parse(String(options.body)) : undefined, accept: headers.Accept! });
      if (url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: [{ name: "CI", status: "completed", conclusion: "success" }], total_count: 1 });
      if (url.pathname.endsWith("/status")) return Response.json({ statuses: [] });
      if (url.pathname.endsWith("/statuses")) return Response.json({ values: [{ name: "CI", state: "SUCCESSFUL" }] });
      if (url.pathname.endsWith("/user")) return Response.json({ id: 1 });
      if (headers.Accept?.includes("diff") || url.pathname.endsWith("/diff")) return new Response(patch);
      if (url.pathname.endsWith("/diffs")) return Response.json([{ old_path: "a.ts", new_path: "a.ts", diff: "@@ -1 +1 @@\n-before\n+after" }]);
      if (url.pathname.endsWith("/notes")) return Response.json(method === "POST" ? {} : [{ author: { username: "reviewer" }, body: "Looks good", created_at: "2026-10-16" }]);
      if (url.pathname.endsWith("/comments")) return Response.json(method === "POST" ? {} : provider === "github" ? [{ user: { login: "reviewer" }, body: "Looks good", created_at: "2026-10-16" }] : { values: [{ user: { display_name: "reviewer" }, content: { raw: "Looks good" }, created_on: "2026-10-16" }] });
      if (url.pathname.endsWith("/reviews")) return Response.json(method === "POST" ? {} : []);
      if (url.pathname.endsWith("/12") || method === "POST" || method === "PUT") return Response.json(fixture);
      return Response.json(provider === "bitbucket" ? { values: [fixture] } : [fixture]);
    };
    try {
      const api = new RestCodeHosts(fetcher);
      await api.connect(path, "origin", "test-only-token");
      const list = await api.list(path, "origin", "", "open", 1);
      assert.equal(list.items[0]?.id, 12); assert.equal(list.items[0]?.source, "fix/parser");
      const detail = await api.detail(path, "origin", 12);
      if (provider !== "gitlab") assert.equal(detail.checks[0]?.name, "CI");
      assert.match(detail.diff, /after/); assert.equal(detail.comments[0]?.body, "Looks good");
      await api.create(path, "origin", { title: "New feature", body: "Details", source: "feature/new", target: "main", draft: true });
      const create = calls.find((call) => call.method === "POST" && /(?:pulls|merge_requests|pullrequests)$/.test(call.url.pathname))!;
      assert.equal(provider === "gitlab" ? create.body.title : create.body.draft, provider === "gitlab" ? "Draft: New feature" : true);
      await api.act(path, "origin", 12, "approve", "Nice", head);
      await api.act(path, "origin", 12, "merge", "", head);
      const merge = calls.find((call) => call.url.pathname.endsWith("/merge"))!;
      assert.equal(merge.method, provider === "bitbucket" ? "POST" : "PUT");
      if (provider !== "bitbucket") assert.equal(merge.body.sha, head);
      await assert.rejects(api.act(path, "origin", 12, "merge", "", base), /New commits/);
      await assert.rejects(api.act(path, "origin", 12, "comment", "", head), /comment is required/);
      if (provider === "gitlab") await assert.rejects(api.act(path, "origin", 12, "request_changes", "Fix", head), /not a portable|depends on server/);
      if (provider === "bitbucket") await assert.rejects(api.act(path, "origin", 12, "reopen", "", head), /does not support reopening/);
    } finally { await rm(path, { recursive: true, force: true }); }
  });
}

test("GitHub search cannot replace repository or state scope and retains pagination", async () => {
  const path = await repository("https://github.com/team/repo.git");
  let query = "";
  const api = new RestCodeHosts(async (input) => {
    const url = new URL(String(input)); if (url.pathname === "/user") return Response.json({});
    query = url.searchParams.get("q") ?? "";
    return Response.json({ items: [github], total_count: 120 });
  });
  try {
    await api.connect(path, "origin", "test");
    const list = await api.list(path, "origin", "parser repo:evil/other is:closed", "open", 2);
    assert.match(query, /repo:team\/repo is:pr is:open/); assert.doesNotMatch(query, /evil|is:closed/); assert.equal(list.hasMore, true);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("provider errors and redirects cannot expose tokens; oversized responses are bounded", async () => {
  const path = await repository("https://github.com/team/repo.git");
  try {
    const denied = new RestCodeHosts(async () => new Response("very-secret-token", { status: 403 }));
    await assert.rejects(denied.connect(path, "origin", "very-secret-token"), (error: Error) => !error.message.includes("very-secret-token") && error.message.includes("Access denied"));
    const redirect = new RestCodeHosts(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }));
    await assert.rejects(redirect.connect(path, "origin", "test"), /outside its API/);
    const oversized = new RestCodeHosts(async () => new Response("x".repeat(2_000_001)));
    await assert.rejects(oversized.connect(path, "origin", "test"), /2 MB/);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("PR sync appears in Timeline as the complete comparison and preserves HEAD, staged and unstaged edits", async () => {
  const source = await repository("https://github.com/team/repo.git");
  const local = await mkdtemp(join(tmpdir(), "rack-review-local-"));
  const data = await mkdtemp(join(tmpdir(), "rack-review-data-"));
  try {
    const commit = async (message: string) => { await git(source, ["add", "."]); await git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.org", "-c", "commit.gpgsign=false", "commit", "-m", message]); };
    await writeFile(join(source, "a.txt"), "original\n"); await commit("base"); const base = await git(source, ["rev-parse", "HEAD"]);
    await git(source, ["switch", "-c", "feature/review"]);
    await writeFile(join(source, "a.txt"), "first\n"); await commit("first");
    await writeFile(join(source, "b.txt"), "second\n"); await commit("second"); const head = await git(source, ["rev-parse", "HEAD"]);
    await git(source, ["update-ref", "refs/pull/12/head", head]);
    await git(local, ["clone", "--branch", "main", source, "."]);
    await writeFile(join(local, "a.txt"), "staged\n"); await git(local, ["add", "a.txt"]); await writeFile(join(local, "a.txt"), "unstaged\n");
    const statusBefore = await git(local, ["status", "--porcelain"]), indexBefore = await git(local, ["write-tree"]), headBefore = await git(local, ["rev-parse", "HEAD"]);
    const remote: Remote = { name: "origin", host: "github.com", provider: "github", slug: "team/repo", api: "https://api.github.com" };
    const checkpointId = await syncReview(local, remote, { id: 12, title: "Review both commits", body: "", author: "", url: "", source: "feature/review", target: "main", head, base, state: "open", draft: false, updatedAt: "2026-10-16T10:00:00Z" });
    const app = createApplication({ dataDirectory: data }); const project = await app.projects.createProject({ path: local });
    const target = { scope: "project" as const, contextId: project.id, checkpointId };
    const snapshot = await app.timeline!.snapshot(target);
    assert.equal(snapshot.previous, base); assert.deepEqual(snapshot.files.filter((file) => file.status).map((file) => file.path), ["a.txt", "b.txt"]);
    assert.match((await app.timeline!.snapshotFile(target, "a.txt")).diff, /original/);
    assert.equal(await git(local, ["status", "--porcelain"]), statusBefore); assert.equal(await git(local, ["write-tree"]), indexBefore); assert.equal(await git(local, ["rev-parse", "HEAD"]), headBefore);
    assert.ok((await app.timeline!.projectHistory(project.id)).checkpoints.some((entry) => entry.id === checkpointId));
    assert.equal((await savedReview(local, remote, 12))?.head, head);
    await git(source, ["update-ref", "refs/merge-requests/12/head", head]);
    const reviewInput = { id: 12, title: "Provider comparison", body: "", author: "", url: "", source: "feature/review", target: "main", head, base, state: "open" as const, draft: false, updatedAt: "2026-10-16T10:00:00Z" };
    assert.match(await syncReview(local, { ...remote, provider: "gitlab", host: "gitlab.com" }, reviewInput), /^checkpoint:/);
    assert.match(await syncReview(local, { ...remote, provider: "bitbucket", host: "bitbucket.org" }, reviewInput), /^checkpoint:/);
    const input = { id: 12, title: "Review both commits", body: "", author: "", url: "", source: "feature/review", target: "main", head, base, state: "open" as const, draft: false, updatedAt: "2026-10-16T10:00:00Z" };
    assert.equal(await syncReview(local, remote, input), checkpointId);
    await writeFile(join(source, "b.txt"), "new revision\n"); await commit("new revision");
    const revisedHead = await git(source, ["rev-parse", "HEAD"]); await git(source, ["update-ref", "refs/pull/12/head", revisedHead]);
    const revised = await syncReview(local, remote, { ...input, head: revisedHead });
    assert.notEqual(revised, checkpointId);
    assert.equal((await savedReview(local, remote, 12))?.head, revisedHead);
    assert.equal((await app.timeline!.snapshot(target)).id, checkpointId);
    assert.equal(await git(local, ["status", "--porcelain"]), statusBefore);
  } finally { await Promise.all([source, local, data].map((path) => rm(path, { recursive: true, force: true }))); }
});

test("desktop PR commands reject paths, invalid page numbers and unknown review actions", () => {
  assert.throws(() => validateCommandParams("reviews.list", { projectId: "p", remote: "origin", state: "open", query: "", page: 0 }));
  assert.throws(() => validateCommandParams("reviews.sync", { projectId: "p", remote: "origin", id: 1, path: "/tmp" }));
  assert.throws(() => validateCommandParams("reviews.act", { projectId: "p", remote: "origin", id: 1, action: "force_merge", body: "", head }));
});
