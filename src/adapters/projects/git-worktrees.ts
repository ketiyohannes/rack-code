/**
 * Git implementation of `IsolatedWorkspaceProvider`: session-owned linked
 * worktrees.
 *
 * Behavior follows the established designs of T3 Code and Codex (researched
 * 2026-10-15; see docs/concurrent-sessions.md):
 * - Layout: `<worktreesRoot>/<repo name>-<root hash>/<branch slug>`. The
 *   hash keeps two repositories with the same folder name apart (Codex
 *   buckets by hash for the same reason).
 * - Branch: a real branch `rack/<8 hex>` (T3 uses `t3/<8 hex>`), created from
 *   the main checkout's current HEAD commit. Uncommitted changes are not
 *   carried over, as in T3 and the Codex CLI.
 * - `git worktree add` runs with hooks and fsmonitor disabled (Codex does
 *   the same), so creating a worktree never runs repository scripts.
 *   Submodules are initialized afterwards, best effort (T3 does this).
 * - The project's path inside its repository is preserved: a project that is
 *   a repository subfolder executes in the same subfolder of the worktree.
 * - `.worktreeinclude` (the Codex app's convention): files that are ignored
 *   in the main checkout and match a pattern in this file at the repository
 *   root are copied into a new worktree, for example `.env` files. Copies
 *   never overwrite, skip symlinks, and use copy-on-write clones where the
 *   filesystem supports them (APFS), so copying `node_modules` is cheap.
 * - Creation is serialized per repository. Concurrent `worktree add` calls
 *   contend on Git's ref and config locks; T3 reports frequent failures when
 *   launching many at once.
 * - Removal deletes the directory and keeps the branch (T3), refusing when
 *   there are uncommitted changes unless forced.
 *
 * The main checkout's working files, index, and HEAD are never modified.
 * Commands run without a shell and with inherited variables that could
 * redirect Git (`GIT_DIR`, `GIT_WORK_TREE`, ...) removed.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

import { IsolationUnavailableError, WorkspaceDirtyError } from "../../core/projects/errors.js";
import type { IsolatedWorkspaceProvider, IsolatedWorkspaceRequest } from "../../core/projects/ports.js";
import type { IsolatedWorkspace } from "../../core/projects/types.js";

const execute = promisify(execFile);

/** Inherited variables that would point Git at another repository or index. */
const REDIRECTING_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_COMMON_DIR"];
/** Applied to commands that check out files: no hooks, no fsmonitor daemon. */
const NO_SCRIPTS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
const BRANCH_PREFIX = "rack/";
/** Upper bound for `.worktreeinclude` copies, so a broad pattern cannot copy a disk. */
const MAX_INCLUDED_FILES = 200_000;

export class GitWorktreeProvider implements IsolatedWorkspaceProvider {
  private readonly queues = new Map<string, Promise<unknown>>();

  async unsupportedReason(projectPath: string): Promise<string | undefined> {
    try {
      await git(projectPath, ["rev-parse", "--show-toplevel"]);
    } catch (error) {
      return isMissingExecutable(error)
        ? "Git is not available, so isolated sessions are not supported."
        : "Isolated sessions need a Git repository. This project folder is not inside one.";
    }
    try {
      await git(projectPath, ["rev-parse", "--verify", "HEAD^{commit}"]);
    } catch {
      return "Isolated sessions need at least one commit to branch from. Commit once, then try again.";
    }
    return undefined;
  }

  create(request: IsolatedWorkspaceRequest): Promise<Omit<IsolatedWorkspace, "createdAt">> {
    return this.serialized(request.projectPath, () => this.createUnlocked(request));
  }

  async exists(workspace: IsolatedWorkspace): Promise<boolean> {
    try {
      // A linked worktree has a `.git` file pointing at the main repository.
      if (!(await stat(join(workspace.worktreePath, ".git"))).isFile()) return false;
      const root = (await git(workspace.worktreePath, ["rev-parse", "--show-toplevel"])).trim();
      return (await realpath(root)) === (await realpath(workspace.worktreePath));
    } catch {
      return false;
    }
  }

  restore(workspace: IsolatedWorkspace): Promise<void> {
    return this.serialized(workspace.checkoutRoot, async () => {
      if (await this.exists(workspace)) return;
      // Forget registrations whose directories are gone, then check the
      // branch out again. A deleted branch is recreated at its base commit.
      await git(workspace.checkoutRoot, ["worktree", "prune"]);
      await mkdir(dirname(workspace.worktreePath), { recursive: true });
      const hasBranch = await git(workspace.checkoutRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${workspace.branch}`]).then(() => true, () => false);
      await git(workspace.checkoutRoot, [...NO_SCRIPTS, "worktree", "add",
        ...(hasBranch ? [workspace.worktreePath, workspace.branch] : ["-b", workspace.branch, workspace.worktreePath, workspace.baseCommit])], { timeout: 120_000 });
      await this.initializeSubmodules(workspace.worktreePath);
      await this.copyIncludedFiles(workspace.checkoutRoot, workspace.worktreePath);
    });
  }

  async status(workspace: IsolatedWorkspace): Promise<{ readonly dirty: boolean; readonly commitsAhead: number }> {
    const [porcelain, ahead] = await Promise.all([
      git(workspace.worktreePath, ["status", "--porcelain", "--untracked-files=normal"]),
      git(workspace.worktreePath, ["rev-list", "--count", `${workspace.baseCommit}..HEAD`]).catch(() => "0"),
    ]);
    return { dirty: porcelain.trim() !== "", commitsAhead: Number.parseInt(ahead.trim(), 10) || 0 };
  }

  remove(workspace: IsolatedWorkspace, options: { readonly force: boolean }): Promise<void> {
    return this.serialized(workspace.checkoutRoot, async () => {
      if (!(await this.exists(workspace))) return;
      if (!options.force && (await this.status(workspace)).dirty) throw new WorkspaceDirtyError(workspace.worktreePath);
      // The branch is kept so the work remains reachable and the session can
      // recreate its worktree on the next run.
      await git(workspace.checkoutRoot, ["worktree", "remove", ...(options.force ? ["--force"] : []), workspace.worktreePath], { timeout: 120_000 });
    });
  }

  private async createUnlocked(request: IsolatedWorkspaceRequest): Promise<Omit<IsolatedWorkspace, "createdAt">> {
    const reason = await this.unsupportedReason(request.projectPath);
    if (reason !== undefined) throw new IsolationUnavailableError(reason);
    const checkoutRoot = await realpath((await git(request.projectPath, ["rev-parse", "--show-toplevel"])).trim());
    const projectPath = await realpath(request.projectPath);
    const subpath = relative(checkoutRoot, projectPath);
    if (isAbsolute(subpath) || subpath === ".." || subpath.startsWith(`..${sep}`)) {
      throw new IsolationUnavailableError("The project folder is not inside its repository checkout.");
    }
    const baseCommit = (await git(checkoutRoot, ["rev-parse", "HEAD^{commit}"])).trim();
    const baseRef = (await git(checkoutRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "HEAD")).trim() || "HEAD";
    const branch = await this.unusedBranch(checkoutRoot);
    const bucket = `${basename(checkoutRoot)}-${createHash("sha256").update(checkoutRoot).digest("hex").slice(0, 8)}`;
    const worktreePath = join(request.worktreesRoot, bucket, branch.replaceAll("/", "-"));
    await mkdir(dirname(worktreePath), { recursive: true });
    await git(checkoutRoot, [...NO_SCRIPTS, "worktree", "add", "-b", branch, worktreePath, baseCommit], { timeout: 120_000 });
    try {
      await this.initializeSubmodules(worktreePath);
      await this.copyIncludedFiles(checkoutRoot, worktreePath);
    } catch (error) {
      // Leave nothing behind: the branch is new and has no commits yet.
      await git(checkoutRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
      await git(checkoutRoot, ["branch", "-D", branch]).catch(() => undefined);
      throw error;
    }
    return {
      sessionId: request.sessionId,
      worktreePath,
      path: subpath === "" ? worktreePath : join(worktreePath, subpath),
      branch,
      baseRef,
      baseCommit,
      checkoutRoot,
    };
  }

  private async unusedBranch(checkoutRoot: string): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const branch = `${BRANCH_PREFIX}${randomBytes(4).toString("hex")}`;
      const taken = await git(checkoutRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
      if (!taken) return branch;
    }
    throw new Error("Could not choose an unused branch name for the isolated session.");
  }

  /** Best effort, like T3: a submodule fetch failure must not block the session. */
  private async initializeSubmodules(worktreePath: string): Promise<void> {
    try {
      await stat(join(worktreePath, ".gitmodules"));
    } catch {
      return;
    }
    await git(worktreePath, [...NO_SCRIPTS, "submodule", "update", "--init", "--recursive"], { timeout: 300_000 }).catch(() => undefined);
  }

  /**
   * Copies ignored files matching `.worktreeinclude` (gitignore syntax) from
   * the main checkout. Only files that are both ignored and matched qualify,
   * so tracked content always comes from the branch.
   */
  private async copyIncludedFiles(checkoutRoot: string, worktreePath: string): Promise<void> {
    const includeFile = join(checkoutRoot, ".worktreeinclude");
    try {
      if ((await readFile(includeFile, "utf8")).trim() === "") return;
    } catch {
      return;
    }
    const [ignored, included] = await Promise.all([
      git(checkoutRoot, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"], { maxBuffer: 256 * 1024 * 1024, timeout: 120_000 }),
      git(checkoutRoot, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${includeFile}`], { maxBuffer: 256 * 1024 * 1024, timeout: 120_000 }),
    ]);
    const ignoredSet = new Set(ignored.split("\0").filter(Boolean));
    const files = included.split("\0").filter((path) => path !== "" && ignoredSet.has(path)).slice(0, MAX_INCLUDED_FILES);
    for (const file of files) {
      const source = join(checkoutRoot, file);
      const target = join(worktreePath, file);
      try {
        if (!(await lstat(source)).isFile()) continue;
        await mkdir(dirname(target), { recursive: true });
        // Never overwrite; clone when the filesystem supports it.
        await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      } catch {
        // A file that disappeared or already exists is skipped.
      }
    }
  }

  /** Runs `operation` after earlier operations on the same repository settle. */
  private async serialized<T>(path: string, operation: () => Promise<T>): Promise<T> {
    let key: string;
    try {
      key = await realpath((await git(path, ["rev-parse", "--git-common-dir"], { absolute: true })).trim());
    } catch {
      key = path;
    }
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const settled = next.then(() => undefined, () => undefined);
    this.queues.set(key, settled);
    void settled.then(() => { if (this.queues.get(key) === settled) this.queues.delete(key); });
    return next;
  }
}

interface GitOptions {
  readonly timeout?: number;
  readonly maxBuffer?: number;
  /** Resolve `--git-common-dir` to an absolute path. */
  readonly absolute?: boolean;
}

async function git(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const name of REDIRECTING_VARIABLES) delete env[name];
  const finalArgs = options.absolute === true && args[0] === "rev-parse" ? ["rev-parse", "--path-format=absolute", ...args.slice(1)] : [...args];
  const { stdout } = await execute("git", ["-C", cwd, ...finalArgs], {
    encoding: "utf8",
    timeout: options.timeout ?? 15_000,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    env,
  });
  return stdout;
}

function isMissingExecutable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    && "path" in error && error.path === "git";
}
