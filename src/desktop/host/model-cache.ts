/** Host-owned discovery cache. Limits provider subprocesses across windows,
 * shares in-flight reads, and never keeps a failed catalog as a success. */
import type { RuntimeModel } from "../../core/execution/types.js";

export class ModelCatalogCache {
  private readonly entries = new Map<string, { expires: number; value: Promise<readonly RuntimeModel[]> }>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  clear(): void { this.entries.clear(); }

  get(key: string, discover: () => Promise<readonly RuntimeModel[]>): Promise<readonly RuntimeModel[]> {
    const cached = this.entries.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const entry = { expires: Infinity, value: this.discover(discover) };
    this.entries.set(key, entry);
    this.prune();
    void entry.value.then(() => {
      entry.expires = Date.now() + 60_000;
      this.prune();
    }, () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.value;
  }

  /** Prune after settlement as well as insertion: a burst can initially hold
   * only pending entries, which must remain shared until they complete. */
  private prune(): void {
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= 32) break;
      if (entry.expires !== Infinity) this.entries.delete(id);
    }
  }

  private async discover(task: () => Promise<readonly RuntimeModel[]>): Promise<readonly RuntimeModel[]> {
    if (this.active >= 2) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try { return await task(); }
    finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }
}
