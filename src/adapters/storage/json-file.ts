import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { dirname } from "node:path";

/**
 * Version-neutral JSON document persistence for the local MVP.
 *
 * Writes use a temporary file followed by rename, so a process crash cannot
 * leave a partially written document at the canonical path. Domain stores add
 * schema versions and own their migrations around this primitive.
 */
export class JsonFileDocument<T> {
  private loaded: T | undefined;
  private loading: Promise<T> | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly initialValue: T,
    /** Domain-owned schema normalization, persisted before callers see data. */
    private readonly migrate?: (stored: unknown, missing: boolean) => T | Promise<T>,
  ) {}

  async read(): Promise<T> {
    return this.select((value) => value);
  }

  /** Project before copying so a small query never clones an entire database.
   * Selectors are internal read-only operations; their results are detached
   * snapshots, with the same ownership guarantees as read().
   */
  async select<R>(project: (value: Readonly<T>) => R): Promise<R> {
    if (this.loaded !== undefined) {
      return structuredClone(project(this.loaded));
    }

    // Share first-load migration across parallel host queries. Otherwise one
    // read can observe an older schema while another is already saving it.
    this.loading ??= this.load();
    try {
      return structuredClone(project(await this.loading));
    } catch (error) {
      this.loading = undefined;
      throw error;
    }
  }

  private async load(): Promise<T> {
    let stored: T;
    let missing = false;
    try {
      const content = await readFile(this.filePath, "utf8");
      stored = JSON.parse(content) as T;
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
      stored = structuredClone(this.initialValue);
      missing = true;
    }
    const migrated = this.migrate === undefined ? stored : await this.migrate(stored, missing);
    if (missing || JSON.stringify(stored) !== JSON.stringify(migrated)) {
      await this.write(migrated);
    }
    this.loaded = migrated;
    return this.loaded;
  }

  async update(mutator: (current: T) => T | Promise<T>): Promise<T> {
    const operation = this.writeChain.then(async () => {
      const current = await this.read();
      const next = await mutator(current);
      // Publish only after the atomic replacement succeeds. A failed save must
      // not become visible to readers or leak into the next queued mutation.
      const committed = structuredClone(next);
      await this.write(committed);
      this.loaded = committed;
      return structuredClone(this.loaded);
    });
    this.writeChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async write(value: T): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8", mode: 0o600, flag: "wx",
      });
      await replaceFileWithRetry(temporaryPath, this.filePath);
    } finally {
      // Remove only this write's staging file, never the canonical document.
      // Cleanup failure must not turn a successful commit into a failed update
      // or mask the original write error. A failed cleanup can leave an orphan.
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

/** Retry transient replacement failures without re-running the domain mutator.
 * Windows readers/indexers can briefly prevent replacement; EBUSY can also
 * occur on other hosts. Permanent failures still surface after 620ms of waits.
 * Never unlink the destination as a workaround: readers must see a whole old
 * or new document. Injectable operations let tests exercise failures reliably.
 */
export async function replaceFileWithRetry(
  source: string, destination: string,
  replace: typeof rename = rename,
  wait: (milliseconds: number) => Promise<void> = delay,
): Promise<void> {
  const pauses = [20, 40, 80, 160, 320];
  for (let attempt = 0; ; attempt += 1) {
    try { await replace(source, destination); return; }
    catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
      const pause = pauses[attempt];
      if (pause === undefined || !["EPERM", "EACCES", "EBUSY"].includes(String(code))) throw error;
      await wait(pause);
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
