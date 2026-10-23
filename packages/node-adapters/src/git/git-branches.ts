/**
 * Explicit branch listing and switching for a project's checkout. This adapter
 * never stashes, resets, cleans, forces a worktree, fetches or changes config.
 * Git's ordinary checkout protections still apply after the optimistic checks.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { BranchOperationError } from "@rack/core/projects/errors";
import type { ProjectBranchRepository } from "@rack/core/projects/ports";
import type { ProjectBranches } from "@rack/core/projects/types";
import { GitRepositoryDiscovery, repositoryScope } from "./git-repositories.js";

const execute = promisify(execFile);
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export class GitProjectBranches implements ProjectBranchRepository {
  private readonly discovery = new GitRepositoryDiscovery();

  /** Resolve a single checkout; ambiguous container folders require a repository choice. */
  private async root(path: string): Promise<string> {
    try { return (await git(path, ["rev-parse", "--show-toplevel"])).trim(); }
    catch {
      const found = await this.discovery.discover(path, {});
      if (found.limited || found.warnings.length || found.paths.length !== 1)
        throw new BranchOperationError("Choose a single Git repository folder before checking out a branch.");
      const selected = await repositoryScope(path, found.paths[0]!);
      return (await git(selected, ["rev-parse", "--show-toplevel"])).trim();
    }
  }

  async repositoryId(path: string): Promise<string> {
    const root = await this.root(path);
    return realpath((await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
  }

  /** `repositoryPath` picks a discovered repository inside `path`; containment is revalidated. */
  async list(path: string, repositoryPath?: string): Promise<ProjectBranches> {
    const root = await this.root(repositoryPath === undefined ? path : await repositoryScope(path, repositoryPath));
    const [id, current, head, dirty, refs] = await Promise.all([
      this.repositoryId(root),
      git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then(s => s.trim()).catch(() => undefined),
      git(root, ["rev-parse", "--verify", "HEAD"]).then(s => s.trim()).catch(() => undefined),
      git(root, ["status", "--porcelain=v1", "--untracked-files=normal"]),
      git(root, ["for-each-ref", "--sort=refname", "--format=%(refname)%00%(objectname)%00%(worktreepath)%00%(symref)", "refs/heads/", "refs/remotes/"]),
    ]);
    return { repositoryRoot: root, repositoryId: id, dirty: dirty.length > 0,
      ...(current ? { current } : {}), ...(head ? { head } : {}),
      branches: refs.split("\n").filter(Boolean).flatMap(line => {
        const [ref, commit, worktreePath, symbolic] = line.split("\0");
        if (!ref || !commit || symbolic) return [];
        const local = ref.startsWith("refs/heads/");
        return [{ ref, commit, name: ref.slice(local ? 11 : 13), kind: local ? "local" as const : "remote" as const,
          ...(worktreePath ? { worktreePath } : {}) }];
      }),
    };
  }

  async checkout(path: string, ref: string, expectedHead: string, repositoryPath?: string): Promise<ProjectBranches> {
    const before = await this.list(path, repositoryPath);
    if (!OBJECT_ID.test(expectedHead) || before.head !== expectedHead)
      throw new BranchOperationError("The checkout changed since the branch list loaded. Refresh and try again.");
    const branch = before.branches.find(b => b.ref === ref);
    if (!branch) throw new BranchOperationError("This branch no longer exists. Refresh the branch list.");
    if (branch.kind === "local" && branch.name === before.current) return before;
    if (before.dirty) throw new BranchOperationError("Commit or stash your changes before switching branches. Rack will keep all files as they are.");
    if (branch.worktreePath && await realpath(branch.worktreePath).catch(() => branch.worktreePath) !== await realpath(before.repositoryRoot))
      throw new BranchOperationError(`This branch is checked out in another worktree: ${branch.worktreePath}`);
    try {
      if (branch.kind === "local") {
        await git(before.repositoryRoot, ["switch", "--no-guess", branch.name]);
      } else {
        // Never guess which remote or reuse an unrelated local branch.
        const name = branch.name.slice(branch.name.indexOf("/") + 1);
        if (before.branches.some(b => b.kind === "local" && b.name === name))
          throw new BranchOperationError(`A local branch named '${name}' already exists. Choose that local branch instead.`);
        await git(before.repositoryRoot, ["check-ref-format", "--branch", name]);
        await git(before.repositoryRoot, ["switch", "--track", "-c", name, branch.ref]);
      }
    } catch (error) {
      if (error instanceof BranchOperationError) throw error;
      // Git can refuse a concurrent worktree/ref change; never retry with force.
      throw new BranchOperationError("Git could not switch branches. Check for a branch in use, unfinished Git operation or files changed since refresh, then try again.");
    }
    return this.list(before.repositoryRoot);
  }
}

/** No shell, checkout hooks or inherited repository/config redirection. */
async function git(path: string, args: readonly string[]): Promise<string> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR$|COMMON_DIR$|WORK_TREE$|INDEX_FILE$|OBJECT_DIRECTORY$|ALTERNATE_OBJECT_DIRECTORIES$|NAMESPACE$|CONFIG|CEILING_DIRECTORIES$)/.test(key)) delete env[key];
  const result = await execute("git", ["-C", path, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args],
    { env, encoding: "utf8", timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout;
}
