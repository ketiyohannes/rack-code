/** Host-owned discovery cache. Limits provider subprocesses across windows,
 * shares in-flight reads, and never keeps a failed catalog as a success. */
import type { RuntimeModel } from "../../core/execution/types.js";

export class ModelCatalogCache {
  private readonly entries = new Map<string, { expires: number; value: Promise<readonly RuntimeModel[]> }>();
  /** Last successful catalog per key, kept past expiry for `allowStale` reads. */
  private readonly lastGood = new Map<string, readonly RuntimeModel[]>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  clear(): void { this.entries.clear(); this.lastGood.clear(); }

  /**
   * Returns the cached catalog or discovers it. With `allowStale`, an expired
   * or in-flight entry with a previous successful result answers immediately
   * from that result while discovery refreshes it in the background. Used for
   * validation on interactive paths (starting a workflow), where waiting for
   * provider discovery (seconds per account) made the start appear frozen.
   */
  get(key: string, discover: () => Promise<readonly RuntimeModel[]>, options: { readonly allowStale?: boolean } = {}): Promise<readonly RuntimeModel[]> {
    const cached = this.entries.get(key);
    if (cached && cached.expires > Date.now()) {
      const stale = this.lastGood.get(key);
      return options.allowStale && cached.expires === Infinity && stale !== undefined ? Promise.resolve(stale) : cached.value;
    }
    const previous = this.lastGood.get(key);
    const entry = { expires: Infinity, value: this.discover(discover) };
    this.entries.set(key, entry);
    this.prune();
    void entry.value.then((models) => {
      entry.expires = Date.now() + 60_000;
      this.lastGood.set(key, models);
      this.prune();
    }, () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return options.allowStale && previous !== undefined ? Promise.resolve(previous) : entry.value;
  }

  /** Prune after settlement as well as insertion: a burst can initially hold
   * only pending entries, which must remain shared until they complete. */
  private prune(): void {
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= 32) break;
      if (entry.expires !== Infinity) { this.entries.delete(id); this.lastGood.delete(id); }
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
