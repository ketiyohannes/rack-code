import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProjectRepositories, RepositoryDiscoveryOptions } from "@rack/core/projects/types";

const execute = promisify(execFile);
const SKIP = new Set([".git", "node_modules", "vendor", "dist", "dist-desktop", "build", "target", ".next", ".cache", ".venv", "venv", "__pycache__"]);

/** Resolve both sides before checking containment, including manually chosen symlinks. */
export async function repositoryScope(workspace: string, candidate: string): Promise<string> {
  const root = await realpath(workspace);
  const path = await realpath(resolve(root, candidate));
  const local = relative(root, path);
  if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) {
    throw new Error("Choose a repository folder inside this workspace.");
  }
  return path;
}

/** Git validates .git directories and files (worktrees/submodules) alike. */
async function isWorkingTree(path: string): Promise<boolean> {
  try {
    const { stdout } = await execute("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], {
      timeout: 2000, maxBuffer: 8192, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout.trim() === "true";
  } catch (error) {
    if (String((error as { stderr?: string }).stderr).includes("not a git repository")) return false;
    throw error;
  }
}

/** Bounded breadth-first discovery, cached independently of frequent diff reads. */
export class GitRepositoryDiscovery {
  private readonly cache = new Map<string, { expires: number; result: Promise<ProjectRepositories> }>();

  async discover(workspace: string, options: RepositoryDiscoveryOptions): Promise<ProjectRepositories> {
    const root = await realpath(workspace);
    const depth = options.deep ? 8 : 3;
    const key = `${root}:${depth}`;
    let entry = this.cache.get(key);
    if (options.rescan) {
      this.cache.delete(`${root}:3`);
      this.cache.delete(`${root}:8`);
      entry = undefined;
    }
    if (!entry || entry.expires < Date.now()) {
      if (this.cache.size >= 50) this.cache.delete(this.cache.keys().next().value!);
      entry = { expires: Date.now() + 60_000, result: this.scan(root, depth) };
      this.cache.set(key, entry);
      // Failed reads remain retryable on the next request.
      void entry.result.catch(() => { if (this.cache.get(key) === entry) this.cache.delete(key); });
    }
    const result = await entry.result;
    if (options.repositoryPath === undefined) return result;
    const selected = await repositoryScope(root, options.repositoryPath);
    if (!await isWorkingTree(selected)) throw new Error("The chosen folder is not inside a Git working tree.");
    const path = relative(root, selected) || ".";
    return { ...result, selectedPath: path, paths: [...new Set([...result.paths, path])].sort() };
  }

  private async scan(root: string, maxDepth: number): Promise<ProjectRepositories> {
    // Preserve existing behavior when a workspace itself is a repo/subfolder.
    if (await isWorkingTree(root)) return { paths: ["."], limited: false, warnings: [] };
    const paths: string[] = [];
    const warnings: string[] = [];
    const queue = [{ path: root, depth: 0 }];
    const deadline = Date.now() + 5000;
    let visited = 0;
    let entries = 0;
    let limited = false;
    while (queue.length) {
      if (++visited > 2000 || Date.now() > deadline || paths.length >= 30) { limited = true; break; }
      const current = queue.shift()!;
      const children: string[] = [];
      let marker = false;
      try {
        // Iterate entries to avoid allocating an unbounded directory listing.
        const directory = await opendir(current.path);
        for await (const entry of directory) {
          if (++entries > 20_000 || Date.now() > deadline) { limited = true; break; }
          if (entry.name === ".git" && (entry.isFile() || entry.isDirectory())) marker = true;
          if (entry.isDirectory() && !SKIP.has(entry.name)) children.push(entry.name);
        }
        if (marker) {
          const checked = await repositoryScope(root, current.path);
          if (await isWorkingTree(checked)) { paths.push(relative(root, checked)); continue; }
          warnings.push(`Could not open repository at ${relative(root, current.path)}.`);
        }
      } catch {
        warnings.push(`Could not inspect ${relative(root, current.path) || "."}.`);
        continue;
      }
      if (entries > 20_000 || Date.now() > deadline) break;
      if (current.depth >= maxDepth) { if (children.length) limited = true; continue; }
      for (const child of children.sort()) queue.push({ path: join(current.path, child), depth: current.depth + 1 });
    }
    return { paths: paths.sort(), limited, warnings };
  }
}
