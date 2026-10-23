import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, open, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ProjectChangesReader } from "@rack/core/projects/ports";
import type { ProjectChanges } from "@rack/core/projects/types";
import { GitRepositoryDiscovery, repositoryScope } from "./git-repositories.js";
import { branchHeader, patchFiles, statusFiles } from "./git-status.js";

const execute = promisify(execFile);
const MAX_DIFF = 1_000_000;
const MAX_NEW_FILE = 128_000;

/**
 * Reads separate index/working-tree changes plus a legacy HEAD comparison,
 * and previews untracked text. Status records preserve partially staged files.
 * Git runs without a shell, external diff drivers or text conversions. Reads
 * are bounded and never stage, reset or modify files (explicit operations
 * live in `git-source-control.ts`). A snapshot can race an
 * editor; periodic refresh supplies the next current view.
 */
export class GitProjectChangesReader implements ProjectChangesReader {
  private readonly repositories = new GitRepositoryDiscovery();

  discover(path: string, options: import("@rack/core/projects/types").RepositoryDiscoveryOptions) {
    return this.repositories.discover(path, options);
  }

  /** Revalidate containment on every read; cached discoveries cannot authorize moved paths. */
  async readRepository(path: string, repositoryPath: string): Promise<ProjectChanges> {
    return this.read(await repositoryScope(path, repositoryPath));
  }

  async read(path: string): Promise<ProjectChanges> {
    const git = async (args: string[]): Promise<string> => (await execute("git", ["-C", path, "-c", "core.quotePath=false", ...args], {
      encoding: "utf8", timeout: 5000, maxBuffer: 2_000_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    })).stdout;
    try {
      if ((await git(["rev-parse", "--is-inside-work-tree"])).trim() !== "true") {
        return { status: "not_git", diff: "", truncated: false };
      }
    } catch (error) {
      // Missing Git and permission failures must not be reported as a clean tree.
      if (String((error as { stderr?: string }).stderr).includes("not a git repository")) {
        return { status: "not_git", diff: "", truncated: false };
      }
      throw error;
    }
    const flags = ["--no-ext-diff", "--no-textconv", "--no-color", "--relative", "--src-prefix=a/", "--dst-prefix=b/"];
    let hasHead = true;
    try { await git(["rev-parse", "--verify", "HEAD"]); } catch { hasHead = false; }
    let diff = hasHead
      ? await git(["diff", ...flags, "HEAD", "--", "."])
      : await git(["diff", ...flags, "--cached", "--", "."]) + await git(["diff", ...flags, "--", "."]);
    // `--branch` adds tracking (upstream, ahead/behind) to the same process,
    // and one rev-parse returns both the scope prefix and the MERGE_HEAD path,
    // so the Changes header costs no extra Git processes per poll.
    const [rawStatus, revParse, staged, working, branch] = await Promise.all([
      git(["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all", "--", "."]),
      git(["rev-parse", "--show-prefix", "--git-path", "MERGE_HEAD"]),
      git(["diff", ...flags, "--cached", "--", "."]),
      git(["diff", ...flags, "--", "."]),
      git(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => hasHead ? git(["rev-parse", "--short", "HEAD"]) : ""),
    ]);
    const [prefix = "", mergeHead = ""] = revParse.split("\n");
    const merging = mergeHead !== "" && await stat(resolve(path, mergeHead)).then(() => true, () => false);
    const tracking = branchHeader(rawStatus);
    const entries = statusFiles(rawStatus, prefix);
    const stagedPatches = patchFiles(staged.slice(0, MAX_DIFF));
    const workingPatches = patchFiles(working.slice(0, MAX_DIFF));
    // Combined merge patches have multiple old line-number columns. Compare
    // unresolved files against stage 2 (ours) for a standard numbered diff.
    const conflicts = entries.some((entry) => entry.group === "conflicts")
      ? await git(["diff", ...flags, "--ours", "--", "."]) : "";
    const conflictPatches = patchFiles(conflicts.slice(0, MAX_DIFF));
    const newPatches = new Map<string, string>();
    const notices = new Map<string, string>();
    const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z", "--", "."])).split("\0").filter(Boolean);
    let truncated = diff.length > MAX_DIFF || staged.length > MAX_DIFF || working.length > MAX_DIFF || conflicts.length > MAX_DIFF || untracked.length > 50 || entries.length > 500;
    for (const name of untracked.slice(0, 50)) {
      if (diff.length >= MAX_DIFF) { truncated = true; break; }
      const fullPath = resolve(path, name);
      const local = relative(path, fullPath);
      if (isAbsolute(local) || local === ".." || local.startsWith("../")) continue;
      // Do not follow untracked symlinks out of the selected project.
      let info;
      try { info = await lstat(fullPath); } catch { continue; }
      if (!info.isFile()) { notices.set(name, "Symbolic link or special file; preview unavailable."); continue; }
      const header = `diff --git ${JSON.stringify(`a/${name}`)} ${JSON.stringify(`b/${name}`)}\nnew file mode 100644\n`;
      if (info.size > MAX_NEW_FILE) { diff += `${header}File too large to preview\n`; notices.set(name, "File too large to preview."); truncated = true; continue; }
      let content: Buffer;
      try {
        // Bound the actual read as well as the stat: an active tool may grow
        // or replace this file between the two operations.
        const file = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const buffer = Buffer.alloc(MAX_NEW_FILE + 1);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          if (bytesRead > MAX_NEW_FILE) { diff += `${header}File too large to preview\n`; notices.set(name, "File too large to preview."); truncated = true; continue; }
          content = buffer.subarray(0, bytesRead);
        } finally { await file.close(); }
      } catch { continue; }
      if (content.includes(0)) { diff += `${header}Binary file\n`; notices.set(name, "Binary file; no text preview."); continue; }
      const text = content.toString("utf8");
      const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
      let patch = `${header}--- /dev/null\n+++ ${JSON.stringify(`b/${name}`)}\n`;
      if (lines.length) patch += `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
      if (text !== "" && !text.endsWith("\n")) patch += "\\ No newline at end of file\n";
      newPatches.set(name, patch);
      diff += patch;
    }
    // Bound returned per-file previews as a whole, while keeping status rows
    // visible even if a large earlier patch consumed the preview budget.
    let budget = MAX_DIFF;
    const files = entries.slice(0, 500).map((entry) => {
      const patch = (entry.status === "untracked" ? newPatches : entry.group === "staged" ? stagedPatches : entry.group === "conflicts" ? conflictPatches : workingPatches).get(entry.path) ?? "";
      const preview = patch.slice(0, budget);
      budget -= preview.length;
      const notice = notices.get(entry.path) ?? (patch.length > preview.length ? "Diff preview limit reached."
        : /^(Binary files |Binary file)/m.test(patch) ? "Binary file; no text preview."
          : entry.group === "conflicts" ? "Unresolved conflict: your branch compared with the working tree."
            : entry.status === "untracked" && !newPatches.has(entry.path) ? "File preview unavailable." : undefined);
      if (patch.length > preview.length) truncated = true;
      return { ...entry, diff: preview, ...(notice === undefined ? {} : { notice }) };
    });
    return {
      status: "ready", diff: diff.slice(0, MAX_DIFF), files, ...(branch.trim() === "" ? {} : { branch: branch.trim() }),
      truncated: truncated || diff.length > MAX_DIFF, ...tracking, hasCommits: hasHead, ...(merging ? { merging } : {}),
    };
  }
}
