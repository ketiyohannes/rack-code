/**
 * Explicit Git operations for the Changes panel: stage, unstage, discard,
 * commit, fetch, pull, push, sync, merge, abort merge and create branch.
 * The behavior follows VS Code's Source Control view and the Git CLI rather
 * than inventing new semantics.
 *
 * Safety model:
 * - Every operation is a user action from the renderer; nothing here runs on
 *   a timer. Background reads stay in `git-changes.ts`.
 * - Git runs without a shell. Paths are passed after `--` with
 *   `--literal-pathspecs`, so names containing `*`, `:` or a leading `-` are
 *   never interpreted as globs, pathspec magic or options. Absolute paths and
 *   `..` segments are rejected before Git starts.
 * - Inherited repository redirection (`GIT_DIR`, `GIT_WORK_TREE`, config
 *   overrides and similar) is removed so the selected folder is the one that
 *   changes.
 * - Git never prompts: `GIT_TERMINAL_PROMPT=0`, a no-op editor, and (on
 *   POSIX) a detached process group without a controlling terminal, so SSH
 *   or credential prompts fail instead of waiting on the terminal that
 *   launched Rack. Credential helpers (keychain, `gh`) keep working.
 * - Unlike the background adapters, user hooks (pre-commit, commit-msg,
 *   pre-push, post-merge) run, as they do in the Git CLI and VS Code.
 * - Operations on one working tree are serialized, so double clicks cannot
 *   race on `index.lock`.
 * - Failures surface Git's own explanation with credentials embedded in
 *   remote URLs redacted.
 */
import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { GitOperationError } from "../../core/projects/errors.js";
import type { ProjectSourceControl } from "../../core/projects/ports.js";
import type { SourceControlAction, SourceControlResult } from "../../core/projects/types.js";
import { repositoryScope } from "./git-repositories.js";

/** Index and ref updates are quick; allow for large repositories and slow disks. */
const LOCAL_TIMEOUT = 30_000;
/** Commits and merges may run hooks (linters, tests) or sign with GPG. */
const HOOK_TIMEOUT = 180_000;
/** Network operations may be slow, but must not hang forever on a dead remote. */
const NETWORK_TIMEOUT = 180_000;
const MAX_OUTPUT = 4 * 1024 * 1024;
/** Upper bound on paths in one request; matches the status row limit with headroom. */
export const MAX_SOURCE_CONTROL_PATHS = 1000;

interface GitResult { readonly stdout: string; readonly stderr: string; readonly code: number }
interface GitOptions {
  /** Short operation name used in error messages, for example "Push". */
  readonly what: string;
  readonly timeout?: number;
  /** Written to stdin, for example a commit message for `commit -F -`. */
  readonly input?: string;
  /** Resolve with the exit code instead of rejecting on a non-zero exit. */
  readonly allowFailure?: boolean;
}

export class GitSourceControl implements ProjectSourceControl {
  /** Tail of the operation chain per working-tree root. */
  private readonly queues = new Map<string, Promise<unknown>>();

  async workTreeRoot(path: string, repositoryPath?: string): Promise<string> {
    const scope = await this.scope(path, repositoryPath);
    const top = (await git(scope, ["rev-parse", "--show-toplevel"], { what: "Git" })).stdout.trim();
    return realpath(top);
  }

  async run(path: string, repositoryPath: string | undefined, action: SourceControlAction): Promise<SourceControlResult> {
    const scope = await this.scope(path, repositoryPath);
    const root = await this.workTreeRoot(scope);
    // Chain after the previous operation on this checkout, even if it failed.
    const previous = this.queues.get(root) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => perform(scope, action));
    this.queues.set(root, next);
    try { return await next; } finally {
      if (this.queues.get(root) === next) this.queues.delete(root);
    }
  }

  /** Revalidate containment on every call; a discovered folder may have moved. */
  private async scope(path: string, repositoryPath: string | undefined): Promise<string> {
    if (repositoryPath === undefined) return path;
    try { return await repositoryScope(path, repositoryPath); }
    catch (error) { throw new GitOperationError(error instanceof Error ? error.message : String(error)); }
  }
}

async function perform(scope: string, action: SourceControlAction): Promise<SourceControlResult> {
  switch (action.kind) {
    case "stage": {
      const paths = checkedPaths(action.paths);
      // -A also stages deletions; for a conflicted file this marks it resolved.
      await git(scope, ["add", "-A", "--", ...paths], { what: "Stage" });
      return { summary: `Staged ${count(paths.length, "file")}.` };
    }
    case "stageAll":
      await git(scope, ["add", "-A", "--", "."], { what: "Stage all" });
      return { summary: "Staged all changes." };
    case "unstage": {
      const paths = checkedPaths(action.paths);
      await unstage(scope, paths);
      return { summary: `Unstaged ${count(paths.length, "file")}.` };
    }
    case "unstageAll":
      await unstage(scope, ["."]);
      return { summary: "Unstaged all changes." };
    case "discard":
      return discard(scope, checkedPaths(action.paths));
    case "discardAll":
      return discardAll(scope);
    case "commit":
      return commit(scope, action);
    case "fetch": {
      if ((await remotes(scope)).length === 0) throw new GitOperationError("This repository has no remote to fetch from.");
      await git(scope, ["fetch", "--all"], { what: "Fetch", timeout: NETWORK_TIMEOUT });
      return { summary: "Fetched from all remotes." };
    }
    case "pull":
      return pull(scope);
    case "push":
      return push(scope);
    case "sync": {
      // VS Code's Sync: pull, then push. An unpublished branch is published.
      if (await upstream(scope) !== undefined) {
        const pulled = await pull(scope);
        if (pulled.conflicts) return pulled;
      }
      const pushed = await push(scope);
      return { summary: `Synchronized. ${pushed.summary}` };
    }
    case "merge":
      return merge(scope, action.ref);
    case "abortMerge": {
      if (!(await merging(scope))) throw new GitOperationError("No merge is in progress.");
      await git(scope, ["merge", "--abort"], { what: "Abort merge" });
      return { summary: "Merge aborted. Files were restored to their state before the merge." };
    }
    case "createBranch":
      return createBranch(scope, action.name);
  }
}

/** Index entries return to HEAD; before the first commit they are removed. */
async function unstage(scope: string, paths: readonly string[]): Promise<void> {
  if (await hasHead(scope)) await git(scope, ["reset", "-q", "--", ...paths], { what: "Unstage" });
  else await git(scope, ["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--", ...paths], { what: "Unstage" });
}

/**
 * Tracked files are restored from the index (so staged work survives, as in
 * VS Code); untracked files are deleted. Conflicted files are refused: they
 * should be resolved, staged, or the merge aborted.
 */
async function discard(scope: string, paths: readonly string[]): Promise<SourceControlResult> {
  if ((await git(scope, ["ls-files", "-u", "-z", "--", ...paths], { what: "Discard" })).stdout !== "")
    throw new GitOperationError("Conflicted files cannot be discarded. Resolve and stage them, or abort the merge.");
  // `ls-files` reports paths relative to the scope, matching the request.
  const untracked = nul((await git(scope, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths], { what: "Discard" })).stdout);
  const untrackedSet = new Set(untracked);
  const tracked = paths.filter((path) => !untrackedSet.has(path));
  if (untracked.length > 0) await git(scope, ["clean", "-f", "-q", "--", ...untracked], { what: "Discard" });
  if (tracked.length > 0) await git(scope, ["restore", "--worktree", "--", ...tracked], { what: "Discard" });
  return { summary: `Discarded changes in ${count(paths.length, "file")}.` };
}

async function discardAll(scope: string): Promise<SourceControlResult> {
  if ((await git(scope, ["ls-files", "-u", "-z", "--", "."], { what: "Discard all" })).stdout !== "")
    throw new GitOperationError("Resolve or abort the merge before discarding all changes.");
  const untracked = nul((await git(scope, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."], { what: "Discard all" })).stdout);
  const modified = nul((await git(scope, ["diff", "--name-only", "-z", "--", "."], { what: "Discard all" })).stdout);
  // Without -x, clean keeps ignored files (build output, .env files).
  if (untracked.length > 0) await git(scope, ["clean", "-f", "-q", "--", "."], { what: "Discard all" });
  // `restore -- .` fails when no tracked file matches, so run it only when needed.
  if (modified.length > 0) await git(scope, ["restore", "--worktree", "--", "."], { what: "Discard all" });
  return { summary: `Discarded changes in ${count(untracked.length + modified.length, "file")}.` };
}

async function commit(scope: string, action: Extract<SourceControlAction, { kind: "commit" }>): Promise<SourceControlResult> {
  const message = action.message.trim();
  const concluding = await merging(scope);
  if (message === "" && !action.amend && !concluding) throw new GitOperationError("Enter a commit message.");
  if (action.all) await git(scope, ["add", "-A", "--", "."], { what: "Commit" });
  // A commit records the whole index, but the panel shows only this folder.
  // Refuse rather than commit staged files the user cannot see here.
  const prefix = (await git(scope, ["rev-parse", "--show-prefix"], { what: "Commit" })).stdout.replace(/\n$/, "");
  const staged = nul((await git(scope, ["diff", "--cached", "--name-only", "-z", "--no-renames"], { what: "Commit" })).stdout);
  if (prefix !== "" && staged.some((path) => !path.startsWith(prefix)))
    throw new GitOperationError("Files outside this folder are staged. Unstage them, or commit from the repository root.");
  if (staged.length === 0 && !action.amend && !concluding) throw new GitOperationError("There are no staged changes to commit.");
  const args = ["commit", ...(action.amend ? ["--amend"] : [])];
  // An empty message keeps the previous message (amend) or Git's prepared merge message.
  if (message === "") await git(scope, [...args, "--no-edit"], { what: "Commit", timeout: HOOK_TIMEOUT });
  else await git(scope, [...args, "-F", "-"], { what: "Commit", timeout: HOOK_TIMEOUT, input: `${message}\n` });
  const head = (await git(scope, ["log", "-1", "--format=%h %s"], { what: "Commit" })).stdout.trim();
  return { summary: `${action.amend ? "Amended" : "Committed"} ${head}.` };
}

async function pull(scope: string): Promise<SourceControlResult> {
  const tracking = await upstream(scope);
  if (tracking === undefined) throw new GitOperationError("This branch has no upstream branch. Publish it first.");
  // Honor the user's pull.rebase/pull.ff choice. Without one, merge (Git's
  // classic default) instead of failing on divergent branches.
  const configured = await git(scope, ["config", "--get-regexp", "^pull\\.(rebase|ff)$"], { what: "Pull", allowFailure: true });
  const result = await git(scope, ["pull", "--no-edit", ...(configured.stdout.trim() === "" ? ["--no-rebase"] : [])],
    { what: "Pull", timeout: NETWORK_TIMEOUT, allowFailure: true });
  if (result.code !== 0) {
    if (await merging(scope)) return { summary: "Pull stopped with merge conflicts. Resolve them, stage the files, then commit.", conflicts: true };
    throw new GitOperationError(`Pull failed: ${explain(result)}`);
  }
  return { summary: /Already up[ -]to[ -]date/i.test(result.stdout) ? "Already up to date." : `Pulled from ${tracking}.` };
}

async function push(scope: string): Promise<SourceControlResult> {
  const branch = await currentBranch(scope);
  if (branch === undefined) throw new GitOperationError("Check out a branch before pushing.");
  if (!(await hasHead(scope))) throw new GitOperationError("Commit at least once before pushing.");
  const tracking = await upstream(scope);
  if (tracking !== undefined) {
    // Plain `git push` respects push.default and per-branch push remotes.
    await git(scope, ["push"], { what: "Push", timeout: NETWORK_TIMEOUT });
    return { summary: `Pushed ${branch} to ${tracking}.` };
  }
  const remote = await publishRemote(scope, branch);
  // HEAD publishes the current branch under the same name without passing the
  // branch name as a separate argument.
  await git(scope, ["push", "--set-upstream", remote, "HEAD"], { what: "Publish", timeout: NETWORK_TIMEOUT });
  return { summary: `Published ${branch} to ${remote}.` };
}

async function merge(scope: string, ref: string): Promise<SourceControlResult> {
  // Only refs Git lists may be merged; a ref always starts with "refs/", so it
  // cannot be read as an option.
  const refs = (await git(scope, ["for-each-ref", "--format=%(refname)", "refs/heads/", "refs/remotes/"], { what: "Merge" })).stdout.split("\n");
  if (!ref.startsWith("refs/") || !refs.includes(ref)) throw new GitOperationError("This branch no longer exists. Refresh and try again.");
  const head = (await git(scope, ["symbolic-ref", "-q", "HEAD"], { what: "Merge", allowFailure: true })).stdout.trim();
  if (ref === head) throw new GitOperationError("Choose a branch other than the current one to merge.");
  if (await merging(scope)) throw new GitOperationError("A merge is already in progress. Commit or abort it first.");
  const remote = ref.startsWith("refs/remotes/");
  const name = ref.replace(/^refs\/(?:heads|remotes)\//, "");
  const current = head.replace(/^refs\/heads\//, "");
  // Merge the full ref (a same-named tag cannot shadow it) but write Git's
  // usual message, which would otherwise quote "refs/heads/...".
  const message = `Merge ${remote ? "remote-tracking branch" : "branch"} '${name}'${current === "" || current === "main" || current === "master" ? "" : ` into ${current}`}`;
  const result = await git(scope, ["merge", "--no-edit", "-m", message, ref], { what: "Merge", timeout: HOOK_TIMEOUT, allowFailure: true });
  if (result.code !== 0) {
    if (await merging(scope)) return { summary: `Merging ${name} stopped with conflicts. Resolve them, stage the files, then commit.`, conflicts: true };
    throw new GitOperationError(`Merge failed: ${explain(result)}`);
  }
  if (/Already up[ -]to[ -]date/i.test(result.stdout)) return { summary: `Already up to date with ${name}.` };
  return { summary: /Fast-forward/.test(result.stdout) ? `Fast-forwarded to ${name}.` : `Merged ${name} into ${current || "HEAD"}.` };
}

async function createBranch(scope: string, input: string): Promise<SourceControlResult> {
  const name = input.trim();
  // A leading "-" would be read as an option by check-ref-format/switch.
  const valid = name !== "" && !name.startsWith("-")
    && (await git(scope, ["check-ref-format", "--branch", name], { what: "Create branch", allowFailure: true })).code === 0;
  if (!valid) throw new GitOperationError("Enter a valid branch name, for example feature/login.");
  if ((await git(scope, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { what: "Create branch", allowFailure: true })).code === 0)
    throw new GitOperationError(`A branch named '${name}' already exists.`);
  // Switching to a new branch at HEAD keeps staged and working changes.
  await git(scope, ["switch", "-c", name], { what: "Create branch" });
  return { summary: `Created and switched to ${name}.` };
}

async function hasHead(scope: string): Promise<boolean> {
  return (await git(scope, ["rev-parse", "--verify", "-q", "HEAD"], { what: "Git", allowFailure: true })).code === 0;
}

async function currentBranch(scope: string): Promise<string | undefined> {
  const result = await git(scope, ["symbolic-ref", "-q", "--short", "HEAD"], { what: "Git", allowFailure: true });
  return result.code === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : undefined;
}

async function upstream(scope: string): Promise<string | undefined> {
  const result = await git(scope, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { what: "Git", allowFailure: true });
  return result.code === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : undefined;
}

async function remotes(scope: string): Promise<readonly string[]> {
  return (await git(scope, ["remote"], { what: "Git" })).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Configured push remote, then `origin`, then the only remote. */
async function publishRemote(scope: string, branch: string): Promise<string> {
  const available = await remotes(scope);
  for (const key of [`branch.${branch}.pushRemote`, "remote.pushDefault"]) {
    const configured = (await git(scope, ["config", "--get", key], { what: "Publish", allowFailure: true })).stdout.trim();
    if (configured !== "" && available.includes(configured)) return configured;
  }
  if (available.includes("origin")) return "origin";
  if (available.length === 1) return available[0]!;
  if (available.length === 0) throw new GitOperationError("This repository has no remote. Add one with `git remote add origin <url>`, then publish.");
  throw new GitOperationError("This repository has several remotes and none is named origin. Set remote.pushDefault, then publish.");
}

/** `MERGE_HEAD` exists for the whole duration of a merge, including after conflicts. */
async function merging(scope: string): Promise<boolean> {
  const path = (await git(scope, ["rev-parse", "--git-path", "MERGE_HEAD"], { what: "Git" })).stdout.trim();
  return stat(resolve(scope, path)).then(() => true, () => false);
}

/** Rejects absolute paths, parent segments and NUL before any Git process starts. */
function checkedPaths(paths: readonly string[]): readonly string[] {
  if (paths.length === 0) throw new GitOperationError("Choose at least one file.");
  if (paths.length > MAX_SOURCE_CONTROL_PATHS) throw new GitOperationError(`Choose at most ${MAX_SOURCE_CONTROL_PATHS} files at a time.`);
  for (const path of paths) {
    if (path === "" || path.includes("\0") || isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes(".."))
      throw new GitOperationError("File paths must stay inside the selected repository folder.");
  }
  return paths;
}

function nul(output: string): string[] { return output.split("\0").filter(Boolean); }
function count(value: number, noun: string): string { return `${value} ${noun}${value === 1 ? "" : "s"}`; }

/**
 * Git's own explanation, without hints, on one line. Credentials embedded in
 * remote URLs (`https://user:token@host`) are redacted before display.
 */
export function explain(result: Pick<GitResult, "stdout" | "stderr">): string {
  const text = (result.stderr.trim() || result.stdout.trim())
    .split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("hint:")).join(" ")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@");
  if (text === "") return "Git reported an error without details.";
  return text.length > 600 ? `${text.slice(0, 597)}…` : text;
}

/** Environment without repository redirection and with every prompt disabled. */
function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:DIR$|COMMON_DIR$|WORK_TREE$|INDEX_FILE$|OBJECT_DIRECTORY$|ALTERNATE_OBJECT_DIRECTORIES$|NAMESPACE$|CONFIG|CEILING_DIRECTORIES$|LITERAL_PATHSPECS$|GLOB_PATHSPECS$|NOGLOB_PATHSPECS$|ICASE_PATHSPECS$)/.test(key)) delete env[key];
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    // ":" is Git's built-in no-op editor; merges and amends never open one.
    GIT_EDITOR: ":",
    GIT_SEQUENCE_EDITOR: ":",
    GIT_MERGE_AUTOEDIT: "no",
  };
}

/**
 * Runs Git once. On POSIX the child gets its own session (detached), so it
 * has no controlling terminal to prompt on, and a timeout kills its whole
 * process group, including SSH, credential helpers and hooks.
 */
function git(cwd: string, args: readonly string[], options: GitOptions): Promise<GitResult> {
  const timeout = options.timeout ?? LOCAL_TIMEOUT;
  const detached = process.platform !== "win32";
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn("git", ["-C", cwd, "--literal-pathspecs", "-c", "core.quotePath=false", ...args], {
        env: gitEnvironment(), detached, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new GitOperationError(`${options.what} failed: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let failure: GitOperationError | undefined;
    const stop = (reason: GitOperationError) => {
      if (failure !== undefined) return;
      failure = reason;
      try {
        if (detached && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* Already exited. */ }
    };
    const timer = setTimeout(() => stop(new GitOperationError(`${options.what} timed out after ${Math.round(timeout / 1000)} seconds.`)), timeout);
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) { stop(new GitOperationError(`${options.what} produced too much output.`)); return; }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error.code === "ENOENT" ? new GitOperationError("Git is not installed or is not on PATH.")
        : new GitOperationError(`${options.what} failed: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure !== undefined) { reject(failure); return; }
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), code: code ?? 1 };
      if (result.code !== 0 && options.allowFailure !== true) reject(new GitOperationError(`${options.what} failed: ${explain(result)}`));
      else resolvePromise(result);
    });
    // Ignore EPIPE when Git exits before reading stdin (for example on a hook failure).
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}
