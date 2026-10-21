/**
 * Decode Git's NUL-delimited porcelain and patch paths inside the adapter.
 * Status paths are repository-root-relative even from a subfolder; strip the
 * selected scope before exposing application-owned change records.
 */
import type { ProjectChangeFile, ProjectChangeStatus } from "../../core/projects/types.js";

const STATUSES: Readonly<Record<string, ProjectChangeStatus>> = {
  M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "type_changed", U: "conflicted", "?": "untracked",
};
const CONFLICTS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function statusFiles(output: string, prefix: string): ProjectChangeFile[] {
  const fields = output.split("\0");
  const files: ProjectChangeFile[] = [];
  const scoped = (name: string | undefined): string | undefined => name !== undefined && name.startsWith(prefix) ? name.slice(prefix.length) : undefined;
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i]!;
    if (record.length < 4) continue;
    const xy = record.slice(0, 2);
    const original = /[RC]/.test(xy) ? fields[++i] : undefined;
    const previousPath = scoped(original);
    const destination = scoped(record.slice(3));
    const path = destination ?? previousPath;
    if (path === undefined || path === "") continue;
    const base = { path, diff: "", ...(previousPath === undefined || destination === undefined ? {} : { previousPath }) };
    if (CONFLICTS.has(xy)) {
      files.push({ ...base, status: "conflicted", group: "conflicts" });
    } else if (xy === "??") {
      files.push({ ...base, status: "untracked", group: "changes" });
    } else {
      const index = STATUSES[xy[0]!];
      const working = STATUSES[xy[1]!];
      // A rename out of a subfolder is a deletion within that scoped view.
      if (index !== undefined) files.push({ ...base, status: destination === undefined ? "deleted" : index, group: "staged" });
      if (working !== undefined) files.push({ ...base, status: destination === undefined ? "deleted" : working, group: "changes" });
    }
  }
  return files;
}

/**
 * Tracking details from the `## ` header that `status --branch` prints as its
 * first record. Formats: `main`, `main...origin/main [ahead 1, behind 2]`,
 * `main...origin/main [gone]`, `No commits yet on main`, `HEAD (no branch)`.
 * A gone upstream is reported as no upstream, so the branch can be published
 * again. `statusFiles` ignores this record because `##` is not a status code.
 */
export function branchHeader(output: string): { readonly upstream?: string; readonly ahead?: number; readonly behind?: number } {
  const first = output.slice(0, output.indexOf("\0") === -1 ? output.length : output.indexOf("\0"));
  if (!first.startsWith("## ")) return {};
  const match = /^(.+?)\.\.\.(\S+)(?: \[(.+)\])?$/.exec(first.slice(3));
  if (match === null || match[3] === "gone") return {};
  const info = match[3] ?? "";
  return {
    upstream: match[2]!,
    ahead: Number(/ahead (\d+)/.exec(info)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(info)?.[1] ?? 0),
  };
}

/** Git uses C escapes for control characters even with core.quotePath=false. */
function decodePath(value: string): string {
  if (!value.startsWith('"')) return value.replace(/\t$/, "");
  const text = value.slice(1, -1);
  return text.replace(/\\([0-7]{1,3}|[abfnrtv\\"])/g, (_match, escape: string) => {
    if (/^[0-7]/.test(escape)) return String.fromCharCode(parseInt(escape, 8));
    return ({ a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", '"': '"' } as Record<string, string>)[escape]!;
  });
}

/** Index whole file patches once, avoiding one Git subprocess per file during polling. */
export function patchFiles(diff: string): ReadonlyMap<string, string> {
  const patches = new Map<string, string>();
  for (const patch of diff.split(/(?=^diff --(?:git|cc|combined) )/m).filter(Boolean)) {
    const lines = patch.split("\n");
    const target = lines.find((line) => line.startsWith("+++ ") && line !== "+++ /dev/null")?.slice(4)
      ?? lines.find((line) => line.startsWith("--- ") && line !== "--- /dev/null")?.slice(4);
    const renamed = lines.find((line) => line.startsWith("rename to ") || line.startsWith("copy to "));
    const combined = lines[0]?.match(/^diff --(?:cc|combined) (.*)$/)?.[1];
    const fallback = lines[0]?.match(/ ("?b\/.*)$/)?.[1];
    const path = target !== undefined ? decodePath(target).replace(/^[ab]\//, "")
      : renamed !== undefined ? decodePath(renamed.slice(renamed.indexOf(" to ") + 4))
        : combined !== undefined ? decodePath(combined)
          : fallback === undefined ? undefined : decodePath(fallback).replace(/^b\//, "");
    if (path !== undefined) patches.set(path, patch);
  }
  return patches;
}
