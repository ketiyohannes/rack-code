/** Bounded Git operations for review discovery and isolated Timeline comparisons. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { CodeHost, PullRequest } from "../../features/pull-requests/index.js";
const exec = promisify(execFile);
export async function git(path: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  try {
    return (await exec("git", ["-C", path, ...args], { timeout: 60_000, maxBuffer: 4_000_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env } })).stdout.trim();
  } catch { throw new Error(`Git ${args[0]} failed. Check repository access and Git credentials.`); }
}
export interface Remote { name: string; host: string; provider: CodeHost; slug: string; api: string }
/** Recognizes cloud remotes and explicitly configured enterprise hosts; strips URL credentials. */
export function parseRemote(name: string, raw: string, hosts = process.env.RACK_CODE_HOSTS ?? ""): Remote | undefined {
  try {
    const url = new URL(raw.includes("://") ? raw : raw.replace(/^(?:[^@/:]+@)?([^/:]+):/, "ssh://$1/"));
    if (!["https:", "ssh:"].includes(url.protocol)) return undefined;
    const host = url.hostname.toLowerCase();
    const configured = hosts.split(",").map((entry) => entry.trim().split("=")).find(([key]) => key === host)?.[1];
    const provider = host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : host === "bitbucket.org" ? "bitbucket" : configured;
    if (provider !== "github" && provider !== "gitlab" && provider !== "bitbucket") return undefined;
    if (provider === "bitbucket" && host !== "bitbucket.org") return undefined; // Data Center has a different API.
    const slug = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    if (!/^[\w.-]+(?:\/[\w.-]+)+$/.test(slug) || slug.split("/").some((part) => part === "." || part === "..")) return undefined;
    if (provider !== "gitlab" && slug.split("/").length !== 2) return undefined;
    return { name, host, provider, slug, api: provider === "github" ? host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`
      : provider === "gitlab" ? `https://${host}/api/v4` : "https://api.bitbucket.org/2.0" };
  } catch { return undefined; }
}
export async function remotes(path: string): Promise<Remote[]> {
  const names = (await git(path, ["remote"])).split("\n").filter(Boolean);
  const result: Remote[] = [];
  for (const name of names.slice(0, 20)) {
    const remote = parseRemote(name, await git(path, ["remote", "get-url", "--", name]));
    if (remote) result.push(remote);
  }
  return result;
}

/** Fetch without checkout/index writes. A synthetic commit compares merge-base to the whole PR. */
function reviewKey(remote: Remote): string {
  return createHash("sha256").update(`${remote.host}/${remote.slug}`).digest("hex").slice(0, 16);
}
/** Latest immutable comparison survives app restart; no network is needed to find it. */
export async function savedReview(path: string, remote: Remote, id: number): Promise<{ checkpointId: string; head: string; base: string } | undefined> {
  try {
    const ref = `refs/rack-pr-timeline/${reviewKey(remote)}/${id}/latest`;
    const [commit, message] = await Promise.all([git(path, ["rev-parse", "--verify", ref]), git(path, ["show", "-s", "--format=%B", ref])]);
    const head = /^Rack-Review-Head: ([a-f\d]+)$/m.exec(message)?.[1], base = /^Rack-Review-Base: ([a-f\d]+)$/m.exec(message)?.[1];
    return head && base ? { checkpointId: `checkpoint:${commit}`, head, base } : undefined;
  } catch { return undefined; }
}

export async function syncReview(path: string, remote: Remote, pull: PullRequest): Promise<string> {
  if (!/^[a-f\d]{40,64}$/i.test(pull.head) || !/^[a-f\d]{40,64}$/i.test(pull.base)) throw new Error("The provider has not resolved this PR's commits yet. Refresh and try again.");
  await git(path, ["check-ref-format", `refs/heads/${pull.target}`]);
  const key = reviewKey(remote);
  const saved = await savedReview(path, remote, pull.id);
  if (saved?.head === pull.head && saved.base === pull.base) return saved.checkpointId;
  const namespace = `refs/rack-pr-objects/${key}/${pull.id}`;
  const source = remote.provider === "github" ? `refs/pull/${pull.id}/head` : remote.provider === "gitlab" ? `refs/merge-requests/${pull.id}/head` : pull.head;
  const fetchArgs = ["fetch", "--no-tags", "--no-write-fetch-head", "--"];
  if (remote.provider === "bitbucket" && pull.sourceRepository && pull.sourceRepository !== remote.slug) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(pull.sourceRepository) || pull.sourceRepository.split("/").some((part) => part === "." || part === "..")) throw new Error("The provider returned an invalid fork repository.");
    const original = await git(path, ["remote", "get-url", "--", remote.name]);
    // Bitbucket Cloud has no Data Center-style refs/pull-requests namespace.
    // Fetch the exact source SHA from its source repository, preserving SSH transport when used.
    const fork = original.startsWith("git@") || original.startsWith("ssh:") ? `git@bitbucket.org:${pull.sourceRepository}.git` : `https://bitbucket.org/${pull.sourceRepository}.git`;
    await git(path, [...fetchArgs, fork, `+${source}:${namespace}/head`]);
    await git(path, [...fetchArgs, remote.name, `+${pull.base}:${namespace}/base`]);
  } else {
    await git(path, [...fetchArgs, remote.name, `+${source}:${namespace}/head`, `+${pull.base}:${namespace}/base`]);
  }
  const head = await git(path, ["rev-parse", `${namespace}/head`]);
  if (head !== pull.head) throw new Error("The PR changed while syncing. Refresh it and try again.");
  const base = await git(path, ["merge-base", `${namespace}/base`, head]);
  const tree = await git(path, ["rev-parse", `${head}^{tree}`]);
  const timestamp = new Date().toISOString();
  const comparison = await git(path, ["-c", "commit.gpgsign=false", "commit-tree", tree, "-p", base, "-m", `PR #${pull.id}: ${pull.title}\n\nRack-Review-Head: ${pull.head}\nRack-Review-Base: ${pull.base}`], {
    GIT_AUTHOR_NAME: "Rack Timeline", GIT_AUTHOR_EMAIL: "timeline@rack.local", GIT_COMMITTER_NAME: "Rack Timeline", GIT_COMMITTER_EMAIL: "timeline@rack.local",
    GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp,
  });
  await git(path, ["update-ref", `refs/rack-pr-timeline/${key}/${pull.id}/latest`, comparison]);
  // Keep previous versions reachable so already-open Timeline windows remain valid.
  await git(path, ["update-ref", `refs/rack-pr-timeline/${key}/${pull.id}/versions/${comparison}`, comparison]);
  return `checkpoint:${comparison}`;
}
