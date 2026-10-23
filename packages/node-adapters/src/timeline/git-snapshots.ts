/**
 * Git implementation of Timeline's `SnapshotRepository`.
 *
 * Capture uses a private temporary index, seeded from a bounded in-memory
 * index cache to reuse Git stat data. Newly ignored entries are removed before:
 *
 *   add -A -- :/ -> write-tree -> commit-tree -> update-ref
 *
 * An unchanged tree stops after write-tree, so the common "nothing changed"
 * observation avoids rehashing unchanged working files.
 *
 * so the user's HEAD, branch, index, and working files are never touched.
 * Only Git objects and the hidden ref named by the caller are written. Two
 * consequences the product documentation discloses:
 * - Git ignore rules decide what enters a snapshot, even for paths the
 *   user's own index tracks; cached entries are checked against current ignores.
 * - Snapshots are not a secrets filter; anything Git would add is stored.
 *
 * Every command runs without a shell. External diff drivers, text
 * conversion, fsmonitor daemons, and commit signing are disabled, and
 * environment variables that could redirect Git to another repository or
 * index (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, ...) are removed from
 * the inherited environment.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GitRepositoryDiscovery, repositoryScope } from "../git/git-repositories.js";

import type {
  SnapshotCaptureInput,
  SnapshotCaptureResult,
  SnapshotHistory,
  SnapshotPatch,
  SnapshotRecord,
  SnapshotRepository,
  TimelineCapability,
  TimelineChangedPath,
  TimelineChangeStatus,
  TimelineFileContent,
} from "@rack/features/timeline";

const execute = promisify(execFile);

/** Author and committer identity of Rack snapshot commits. */
export const TIMELINE_AUTHOR = { name: "Rack timeline", email: "timeline@rack.local" } as const;

const UNSUPPORTED = "Timeline is not supported for this project.";
const GIT_MISSING = "Git is not available, so Timeline is not supported for this project.";
const MAX_PATCH = 400_000;
/** Historical contents are loaded lazily, one bounded file at a time. */
const MAX_CONTENT = 1024 * 1024;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** Display exclusions apply even when these directories are committed. */
const EXCLUDED_COMPONENTS = new Set([".git", ".github", "node_modules", ".runtime"]);
/** Inherited variables that would point Git at another repository or index. */
const REDIRECTING_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_COMMON_DIR"];
/** Configuration overrides applied to every command. */
const SAFE_CONFIG = ["-c", "core.quotePath=false", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false"];
/** How long a resolved repository root is reused before re-checking. */
const ROOT_CACHE_MS = 10_000;

export interface GitSnapshotRepositoryOptions {
  /** Per-command timeout for capture operations; large repositories need more. */
  readonly captureTimeoutMs?: number;
  /** Clock used for snapshot timestamps, for tests. */
  readonly now?: () => Date;
}

export class GitSnapshotRepository implements SnapshotRepository {
  private readonly indexes = new Map<string, Buffer>();
  private readonly roots = new Map<string, { readonly root: string; readonly expires: number }>();
  private readonly discovery = new GitRepositoryDiscovery();
  private readonly captureTimeoutMs: number;
  private readonly now: () => Date;

  constructor(options: GitSnapshotRepositoryOptions = {}) {
    this.captureTimeoutMs = options.captureTimeoutMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
  }

  async probe(projectPath: string): Promise<TimelineCapability> {
    try {
      let root: string | undefined;
      try { root = await workingTreeRoot(projectPath); }
      catch (error) { if (isMissingExecutable(error)) throw error; }
      if (root === undefined) {
        // Projects can be container folders (for example rack-desktop with
        // rack-code inside). Reuse bounded discovery from Changes, but never
        // silently choose one repository from an ambiguous/incomplete scan.
        this.roots.delete(projectPath);
        const found = await this.discovery.discover(projectPath, {});
        if (found.paths.length > 1) return { supported: false,
          reason: "This project contains multiple Git repositories. Open a repository folder to use Timeline." };
        if (found.limited || found.warnings.length > 0) return { supported: false,
          reason: "Repository discovery is incomplete. Open a repository folder to use Timeline." };
        const candidate = found.paths[0];
        if (candidate === undefined) return { supported: false, reason: UNSUPPORTED };
        const nested = await workingTreeRoot(await repositoryScope(projectPath, candidate));
        if (nested === undefined) return { supported: false, reason: UNSUPPORTED };
        root = await repositoryScope(projectPath, nested);
      }
      this.roots.set(projectPath, { root, expires: Date.now() + ROOT_CACHE_MS });
      return { supported: true, repositoryRoot: root };
    } catch (error) {
      this.roots.delete(projectPath);
      // A missing executable is ENOENT from spawn; a missing project folder
      // surfaces as Git failing to change directory. Both are unsupported.
      return { supported: false, reason: isMissingExecutable(error) ? GIT_MISSING : UNSUPPORTED };
    }
  }

  async capture(input: SnapshotCaptureInput): Promise<SnapshotCaptureResult> {
    const root = await this.root(input.projectPath);
    const directory = await mkdtemp(join(tmpdir(), "rack-timeline-index-"));
    const timestamp = new Date(Math.floor(this.now().getTime() / 1000) * 1000);
    const date = `${Math.floor(timestamp.getTime() / 1000)} +0000`;
    const env = {
      GIT_INDEX_FILE: join(directory, "index"),
      GIT_AUTHOR_NAME: TIMELINE_AUTHOR.name,
      GIT_AUTHOR_EMAIL: TIMELINE_AUTHOR.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: TIMELINE_AUTHOR.name,
      GIT_COMMITTER_EMAIL: TIMELINE_AUTHOR.email,
      GIT_COMMITTER_DATE: date,
    };
    const options = { env, timeout: this.captureTimeoutMs };
    try {
      const cached = this.indexes.get(root);
      if (cached !== undefined) {
        await writeFile(env.GIT_INDEX_FILE, cached, { mode: 0o600 });
        // A previously captured file can become ignored. A normal persistent
        // Git index would keep it tracked, violating Timeline's ignore policy.
        const ignored = await git(root, ["ls-files", "--cached", "--ignored", "--exclude-standard", "-z"], options);
        if (ignored) await gitWithInput(root, ["update-index", "--force-remove", "-z", "--stdin"], ignored, [], env);
      }
      const tip = await this.resolveTip(root, input.ref);
      const baseline = tip ?? (input.startFromHead === true ? await this.resolveTip(root, "HEAD") : undefined);
      const previous = baseline?.commit;
      // `:/` is the repository root, so a session folder that is a
      // subdirectory still snapshots the whole repository.
      await git(root, ["add", "-A", "--", ":/"], options);
      const tree = (await git(root, ["write-tree"], options)).trim();
      const index = await readFile(env.GIT_INDEX_FILE);
      this.indexes.delete(root);
      // At most 16 MiB of private stat data; temporary indexes are still
      // removed in finally and no user index is ever opened for writing.
      if (index.length <= 4 * 1024 * 1024) this.indexes.set(root, index);
      while ([...this.indexes.values()].reduce((total, value) => total + value.length, 0) > 16 * 1024 * 1024) this.indexes.delete(this.indexes.keys().next().value!);
      if (baseline !== undefined && baseline.tree === tree) return { kind: "unchanged", snapshot: baseline.commit };
      const snapshot = (await git(root, ["commit-tree", tree, ...(previous === undefined ? [] : ["-p", previous]), "-m", commitMessage(input.label, input.trailers)], options)).trim();
      if (!OBJECT_ID.test(snapshot)) throw new Error("Git returned an invalid snapshot ID.");
      // Compare-and-swap: fails if another writer advanced the ref meanwhile
      // (an empty old value requires the ref not to exist yet).
      await git(root, ["update-ref", "-m", `rack timeline: ${oneLine(input.label)}`, input.ref, snapshot, tip?.commit ?? ""], options);
      return {
        kind: "created",
        snapshot,
        changedPaths: previous === undefined ? [] : await this.changedPathsAt(root, previous, snapshot),
        createdAt: timestamp.toISOString(),
        ...(previous === undefined ? {} : { previous }),
      };
    } catch (error) {
      this.indexes.delete(root);
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async existingRefs(projectPath: string, refs: readonly string[]): Promise<readonly string[]> {
    if (refs.length === 0) return [];
    const root = await this.root(projectPath);
    // for-each-ref patterns match whole path components as prefixes, so
    // `refs/x/abc` would also list `refs/x/abc/more`. Keep exact names only.
    const listed = new Set((await git(root, ["for-each-ref", "--format=%(refname)", ...refs])).split("\n").filter(Boolean));
    return refs.filter((ref) => listed.has(ref));
  }

  async history(projectPath: string, refs: readonly string[], limit: number): Promise<SnapshotHistory> {
    if (refs.length === 0) return { records: [], truncated: false };
    const root = await this.root(projectPath);
    const output = await git(root, [
      "log", "--first-parent", `--max-count=${limit}`, "-z",
      "--decorate=full", "--format=%H%x1f%P%x1f%at%x1f%an%x1f%D%x1f%B", ...refs, "--",
    ], { timeout: 20_000 });
    const records = output.split("\0").filter((entry) => entry.trim() !== "").map(parseRecord).reverse();
    return { records, truncated: records.length >= limit };
  }

  async projectHistory(projectPath: string, limit: number, mode: "current" | "all" = "current"): Promise<SnapshotHistory> {
    const root = await this.root(projectPath);
    // Glob revisions are expanded by Git, so repositories with many session
    // refs do not risk overflowing the process argument limit. An unborn HEAD
    // is omitted; saved snapshots can still exist before the first commit.
    const head = await this.resolveTip(root, "HEAD");
    if (mode === "all") {
      // Follow every parent so merged topic commits and unmerged branches are
      // visible once. Exclude stash/other unrelated refs; Timeline namespaces
      // remain explicit. Topological order retains merge relationships even
      // when commit clocks are out of order.
      const output = await git(root, ["log", "--topo-order", `--max-count=${limit}`, "-z", "--decorate=full",
        "--format=%H%x1f%P%x1f%at%x1f%an%x1f%D%x1f%B",
        ...(head ? ["HEAD"] : []), "--branches", "--remotes",
        "--glob=refs/rack-timeline/*", "--glob=refs/codex-timeline/*", "--glob=refs/relay-timeline/*",
        "--glob=refs/rack-project-timeline/*", "--glob=refs/rack-pr-timeline/*", "--"], { timeout: 20_000 });
      const records = output.split("\0").filter(entry => entry.trim()).map(parseRecord).reverse();
      return { records, truncated: records.length >= limit };
    }
    return this.history(projectPath, [
      "--date-order",
      ...(head === undefined ? [] : ["HEAD"]),
      "--glob=refs/rack-timeline/*", "--glob=refs/codex-timeline/*", "--glob=refs/relay-timeline/*",
      "--glob=refs/rack-project-timeline/*", "--glob=refs/rack-pr-timeline/*",
    ], limit);
  }

  async changedPaths(projectPath: string, previous: string | undefined, snapshot: string): Promise<readonly TimelineChangedPath[]> {
    return this.changedPathsAt(await this.root(projectPath), previous === undefined ? undefined : requireObjectId(previous), requireObjectId(snapshot));
  }

  async visiblePaths(projectPath: string, paths: readonly string[]): Promise<readonly string[]> {
    const candidates = paths.filter((path) => !path.split("/").some((part) => EXCLUDED_COMPONENTS.has(part)));
    if (candidates.length === 0) return [];
    const root = await this.root(projectPath);
    // `--no-index` applies current ignore rules to tracked paths as well,
    // including nested .gitignore files, negations, and global excludes.
    const ignored = new Set((await gitWithInput(root, ["check-ignore", "--no-index", "-z", "--stdin"], `${candidates.join("\0")}\0`, [1]))
      .split("\0").filter(Boolean));
    return candidates.filter((path) => !ignored.has(path));
  }

  async patch(projectPath: string, previous: string | undefined, snapshot: string, path: string): Promise<SnapshotPatch> {
    const root = await this.root(projectPath);
    const output = await git(root, [
      ...(previous === undefined ? ["show", "--format=", "--root"] : ["diff"]),
      "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--unified=3",
      "--src-prefix=a/", "--dst-prefix=b/",
      ...(previous === undefined ? [] : [requireObjectId(previous)]), requireObjectId(snapshot), "--", `:(literal)${path}`,
    ], { maxBuffer: MAX_PATCH * 4 });
    return {
      diff: output.slice(0, MAX_PATCH),
      truncated: output.length > MAX_PATCH,
      binary: /^Binary files .* differ$/m.test(output),
    };
  }

  async tree(projectPath: string, snapshot: string): Promise<readonly string[]> {
    const root = await this.root(projectPath);
    return (await git(root, ["ls-tree", "-r", "--name-only", "-z", requireObjectId(snapshot), "--"]))
      .split("\0").filter(Boolean);
  }

  async content(projectPath: string, snapshot: string, path: string): Promise<TimelineFileContent> {
    const root = await this.root(projectPath);
    // Literal lookup and an exact-name comparison cover pathspec characters,
    // colons, tabs and newlines without constructing a revision:path expression.
    const listed = await git(root, ["--literal-pathspecs", "ls-tree", "-l", "-z", requireObjectId(snapshot), "--", path]);
    const entry = listed.split("\0").find((line) => line.slice(line.indexOf("\t") + 1) === path);
    const metadata = entry?.slice(0, entry.indexOf("\t")).trim().split(/\s+/);
    if (metadata === undefined) throw new Error("File is not part of this snapshot.");
    const [mode, type, object, size] = metadata;
    if (mode === "120000") return { text: "", truncated: false, notice: "Symbolic link; content preview unavailable." };
    if (type !== "blob") return { text: "", truncated: false, notice: "Submodule; content preview unavailable." };
    if (Number(size) > MAX_CONTENT) return { text: "", truncated: true, notice: "File exceeds 1 MiB; content preview unavailable." };
    // Read bytes directly: the ordinary Git text helper trims a newline, which
    // would corrupt exact historical contents and empty-file comparisons.
    const { stdout } = await execute("git", ["-C", root, ...SAFE_CONFIG, "cat-file", "blob", requireObjectId(object ?? "")], {
      encoding: "buffer", timeout: 10_000, maxBuffer: MAX_CONTENT + 1, env: environment(undefined),
    });
    if (stdout.includes(0)) return { text: "", truncated: false, notice: "Binary file; no text preview." };
    return { text: stdout.toString("utf8"), truncated: false };
  }

  private async changedPathsAt(root: string, previous: string | undefined, snapshot: string): Promise<readonly TimelineChangedPath[]> {
    const fields = (await git(root, ["diff-tree", "-r", "--no-commit-id", "--root", "--no-renames", "--name-status", "-z",
      ...(previous === undefined ? [] : [previous]), snapshot, "--"])).split("\0");
    const changes: TimelineChangedPath[] = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const letter = fields[index];
      const path = fields[index + 1];
      if (letter === undefined || letter === "" || path === undefined || path === "") continue;
      changes.push({ path, status: changeStatus(letter) });
    }
    return changes;
  }

  /** Current chain tip and its tree in one process; `undefined` when the ref does not exist. */
  private async resolveTip(root: string, ref: string): Promise<{ readonly commit: string; readonly tree: string } | undefined> {
    let output: string;
    try {
      output = await git(root, ["log", "-1", "--format=%H %T", ref, "--"]);
    } catch {
      return undefined;
    }
    const [commit = "", tree = ""] = output.trim().split(" ");
    return OBJECT_ID.test(commit) && OBJECT_ID.test(tree) ? { commit, tree } : undefined;
  }

  /** Repository root for a project folder; reused briefly to avoid a probe per command. */
  private async root(projectPath: string): Promise<string> {
    const cached = this.roots.get(projectPath);
    if (cached !== undefined && cached.expires > Date.now()) return cached.root;
    const capability = await this.probe(projectPath);
    if (!capability.supported) throw new Error(capability.reason);
    return capability.repositoryRoot;
  }
}

/** Resolve real Git/worktree roots; no child discovery for a folder already in Git. */
async function workingTreeRoot(path: string): Promise<string | undefined> {
  const output = await git(path, ["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { timeout: 5000 });
  const [inside, root] = output.split("\n");
  return inside === "true" && root !== "" ? root : undefined;
}

/** Subject `timeline: <label>` keeps compatibility with other timeline readers. */
function commitMessage(label: string, trailers: Readonly<Record<string, string>>): string {
  const lines = Object.entries(trailers).map(([key, value]) => `${key}: ${oneLine(value)}`);
  return `timeline: ${oneLine(label)}\n\n${lines.join("\n")}\n`;
}

function parseRecord(entry: string): SnapshotRecord {
  const [hash = "", parents = "", time = "0", author = "", decorations = "", ...rest] = entry.replace(/^\n/, "").split("\x1f");
  const body = rest.join("\x1f");
  const subject = body.split("\n")[0] ?? "";
  const trailers = new Map<string, string>();
  for (const line of body.split("\n")) {
    const match = /^(Rack-Timeline-[A-Za-z-]+):\s*(.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) trailers.set(match[1], match[2]);
  }
  const rack = author === TIMELINE_AUTHOR.name && (trailers.has("Rack-Timeline-Session") || trailers.has("Rack-Timeline-Project"));
  const external = !rack && (author === "Relay timeline" || /^(?:codex-)?timeline:/.test(subject));
  const previous = parents.split(" ")[0];
  const runId = rack ? trailers.get("Rack-Timeline-Run") : undefined;
  const toolCallId = rack ? trailers.get("Rack-Timeline-Tool-Call") : undefined;
  const sessionId = rack ? trailers.get("Rack-Timeline-Session") : undefined;
  const projectId = rack ? trailers.get("Rack-Timeline-Project") : undefined;
  return {
    snapshot: hash,
    parents: parents.split(" ").filter(Boolean),
    branches: decorations.split(", ").map(ref => ref.replace(/^HEAD -> /, ""))
      .filter(ref => ref.startsWith("refs/heads/") || ref.startsWith("refs/remotes/"))
      .map(ref => ref.replace(/^refs\/(?:heads|remotes)\//, "")),
    createdAt: new Date(Number(time) * 1000).toISOString(),
    label: subject.replace(/^(?:codex-)?timeline:\s*/, "").trim() || "Snapshot",
    format: rack ? "rack" : external ? "external" : "other",
    ...(previous === undefined || previous === "" ? {} : { previous }),
    ...(runId === undefined ? {} : { runId }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(projectId === undefined ? {} : { projectId }),
  };
}

function changeStatus(letter: string): TimelineChangeStatus {
  switch (letter[0]) {
    case "A": return "added";
    case "D": return "deleted";
    case "T": return "type_changed";
    default: return "modified";
  }
}

function requireObjectId(value: string): string {
  if (!OBJECT_ID.test(value)) throw new Error("Invalid snapshot ID.");
  return value;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 200);
}

function isMissingExecutable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    && "path" in error && error.path === "git";
}

interface GitOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly timeout?: number;
  readonly maxBuffer?: number;
}

function environment(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  for (const name of REDIRECTING_VARIABLES) delete env[name];
  return { ...env, ...extra };
}

async function git(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<string> {
  const { stdout } = await execute("git", ["-C", cwd, ...SAFE_CONFIG, ...args], {
    encoding: "utf8",
    timeout: options.timeout ?? 10_000,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    env: environment(options.env),
  });
  return stdout.replace(/\n$/, "");
}

/** Runs Git with stdin; exit codes in `allowedCodes` are treated as success. */
function gitWithInput(cwd: string, args: readonly string[], input: string, allowedCodes: readonly number[], extraEnv?: Readonly<Record<string, string>>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["-C", cwd, ...SAFE_CONFIG, ...args], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 32 * 1024 * 1024, env: environment(extraEnv),
    }, (error, stdout) => {
      if (error !== null && !(typeof error.code === "number" && allowedCodes.includes(error.code))) reject(error);
      else resolve(stdout);
    });
    child.stdin?.on("error", reject);
    child.stdin?.end(input);
  });
}
