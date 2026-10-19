/** Shared native project watchers. Batch Git ignore checks before notifying
 * Timeline so build/dependency output does not trigger full snapshots. Unknown
 * filenames and failed checks still notify: optimization must not lose edits. */
import { watch, type FSWatcher } from "node:fs";
import { execFile } from "node:child_process";
import type { ProjectWatcher, WatchHandle } from "../../features/timeline/index.js";

interface SharedWatch { readonly listeners: Set<() => void>; closed: boolean; close(): void }
export class NodeProjectWatcher implements ProjectWatcher {
  private readonly watches = new Map<string, SharedWatch>();

  watch(root: string, onChange: () => void): WatchHandle | undefined {
    let shared = this.watches.get(root);
    if (!shared || shared.closed) {
      let watcher: FSWatcher;
      const listeners = new Set<() => void>();
      const paths = new Set<string>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let checking = false, unknown = false;
      const schedule = () => { timer ??= setTimeout(() => { timer = undefined; void flush(); }, 120); };
      const flush = async () => {
        if (entry.closed) return;
        if (checking) { schedule(); return; }
        checking = true;
        const batch = [...paths]; paths.clear(); const force = unknown; unknown = false;
        try {
          if (force || await hasVisibleChanges(root, batch)) {
            if (!entry.closed) for (const listener of listeners) listener();
          }
        } finally { checking = false; if (paths.size || unknown) schedule(); }
      };
      const entry: SharedWatch = { listeners, closed: false, close: () => {
        if (entry.closed) return;
        entry.closed = true; clearTimeout(timer); watcher.close();
        if (this.watches.get(root) === entry) this.watches.delete(root);
      } };
      try {
        watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
          const path = filename === null ? undefined : String(filename).replace(/\\/g, "/");
          // Ignore our ref/object writes, but honor repository-local excludes.
          if (path?.split("/").includes(".git") && path !== ".git/info/exclude") return;
          if (path === undefined || path === ".git/info/exclude" || path.endsWith(".gitignore") || paths.size >= 1000) unknown = true;
          else paths.add(path);
          schedule();
        });
      } catch { return undefined; }
      watcher.on("error", entry.close);
      this.watches.set(root, entry); shared = entry;
    }
    const entry = shared;
    entry.listeners.add(onChange);
    let closed = false;
    return { get closed() { return closed || entry.closed; }, close: () => {
      if (closed) return;
      closed = true; entry.listeners.delete(onChange);
      if (entry.listeners.size === 0) entry.close();
    } };
  }
}

/** Uses the same current Git ignores as capture, including global excludes.
 * A failed/oversized check conservatively asks Timeline to inspect the tree. */
export function hasVisibleChanges(root: string, paths: readonly string[]): Promise<boolean> {
  if (paths.length === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete (env as NodeJS.ProcessEnv)[key];
    const child = execFile("git", ["-C", root, "check-ignore", "--no-index", "-z", "--stdin"], {
      env, encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error && error.code !== 1) { resolve(true); return; }
      const ignored = new Set(stdout.split("\0").filter(Boolean));
      resolve(paths.some((path) => !ignored.has(path)));
    });
    child.stdin?.on("error", () => resolve(true));
    child.stdin?.end(`${paths.join("\0")}\0`);
  });
}
