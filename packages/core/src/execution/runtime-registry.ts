import { RuntimeNotFoundError } from "./errors.js";
import type { RuntimeAdapter } from "./types.js";

/** Explicit runtime assembly point; adapters are registered by composition code. */
export class RuntimeRegistry {
  private readonly adapters = new Map<string, RuntimeAdapter>();

  register(adapter: RuntimeAdapter): void {
    if (this.adapters.has(adapter.runtimeId)) {
      throw new Error(`Runtime '${adapter.runtimeId}' is already registered.`);
    }
    this.adapters.set(adapter.runtimeId, adapter);
  }

  /** Registered runtime IDs in registration order for host composition and diagnostics. */
  list(): readonly string[] {
    return [...this.adapters.keys()];
  }

  get(runtimeId: string): RuntimeAdapter {
    const adapter = this.adapters.get(runtimeId);
    if (adapter === undefined) {
      throw new RuntimeNotFoundError(runtimeId);
    }
    return adapter;
  }
}
