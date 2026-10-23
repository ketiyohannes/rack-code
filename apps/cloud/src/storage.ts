/**
 * Serialized document persistence.
 *
 * Each capability owns one document (accounts, billing, machines, registry)
 * rather than sharing a table, which keeps their schemas independent. Two
 * implementations share the interface: a JSON file for a running service and
 * an in-memory document for tests. Both serialize `update` calls, so a
 * read-modify-write cannot interleave with another one; that is what makes
 * uniqueness checks (one account per email address) and quota checks hold
 * under concurrent requests.
 *
 * File writes go to a temporary path and are renamed, so a crash mid-write
 * cannot leave a truncated document at the canonical path. A mutator that
 * throws leaves the stored value untouched and keeps the queue usable.
 *
 * This is a single-process store: it is the right size for one control-plane
 * instance and is the obvious thing to replace with a database when the
 * service needs more than one.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Document<T> {
  read(): Promise<T>;
  update(mutate: (current: T) => T): Promise<T>;
}

export class MemoryDocument<T> implements Document<T> {
  private value: T;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(initial: T) {
    this.value = structuredClone(initial);
  }

  async read(): Promise<T> {
    return structuredClone(this.value);
  }

  update(mutate: (current: T) => T): Promise<T> {
    const operation = this.queue.then(() => {
      const next = mutate(structuredClone(this.value));
      this.value = next;
      return structuredClone(next);
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

export class JsonFileDocument<T> implements Document<T> {
  private loaded: T | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly initialValue: T,
  ) {}

  async read(): Promise<T> {
    this.loaded ??= await this.load();
    return structuredClone(this.loaded);
  }

  update(mutate: (current: T) => T): Promise<T> {
    const operation = this.queue.then(async () => {
      const current = this.loaded ?? (await this.load());
      const next = mutate(structuredClone(current));
      await this.write(next);
      this.loaded = next;
      return structuredClone(next);
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async load(): Promise<T> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as T;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      return structuredClone(this.initialValue);
    }
  }

  private async write(value: T): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
