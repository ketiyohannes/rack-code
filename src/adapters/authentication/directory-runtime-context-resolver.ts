import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RuntimeContextResolver } from "../../core/authentication/contracts.js";

/**
 * Creates private native configuration directories or resolves explicitly
 * linked local CLI contexts without modifying their permissions.
 *
 * The provider receives this directory as CODEX_HOME or CLAUDE_CONFIG_DIR,
 * so switching accounts cannot reuse native token caches or session files.
 * Context IDs are hashed before becoming path components; an account record
 * therefore cannot escape the configured root through a path-like ID.
 */
export class DirectoryRuntimeContextResolver implements RuntimeContextResolver {
  constructor(private readonly rootDirectory: string) {}

  async resolve(runtimeContextId: string): Promise<{ readonly directory: string }> {
    if (runtimeContextId.trim() === "") {
      throw new Error("Runtime context id is required.");
    }
    // Explicitly linked CLI accounts share provider state; never chmod the
    // user's existing directory or copy credentials into application storage.
    if (runtimeContextId === "local-claude-login") {
      return { directory: process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude") };
    }
    if (runtimeContextId === "local-codex-login") {
      return { directory: process.env["CODEX_HOME"] || join(homedir(), ".codex") };
    }
    const directory = join(
      this.rootDirectory,
      createHash("sha256").update(runtimeContextId).digest("hex"),
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // chmod also repairs permissions when a pre-existing directory was made
    // with a process umask that was more permissive than the account boundary.
    await chmod(directory, 0o700);
    return { directory };
  }
}
