import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
      this.loaded = structuredClone(next);
      await this.write(this.loaded);
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
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
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
