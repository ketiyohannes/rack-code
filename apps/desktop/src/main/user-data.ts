/**
 * Adoption of the window layer's stored state after the product rename.
 *
 * Electron derives the user-data directory from the application name, and
 * the renderer keeps its preferences there: theme, favourite models, sidebar
 * order and the model chosen per session. The host's own records live
 * elsewhere (`~/.rack`, see `@rack/node-adapters/storage/data-directory`);
 * this module handles only the Chromium profile beside it.
 *
 * Renaming the application to Rack renames that directory too, which would
 * silently reset those preferences. The fix is the same one the host uses:
 * if the current directory does not exist yet and one written under a former
 * name does, move it once.
 *
 * Two former names are checked because development and packaged builds
 * disagreed on casing: a packaged build took its name from the generated
 * manifest (`thinking-and-code`) while `electron .` took it from this
 * workspace's `productName` ("Thinking and Code").
 *
 * This must run before anything touches the directory. In particular before
 * `app.requestSingleInstanceLock()`, which writes a lock file inside it.
 */
import { renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Names the user-data directory has had before the rename to Rack. */
export const LEGACY_APP_NAMES: readonly string[] = ["thinking-and-code", "Thinking and Code"];

/** File system operations used here; injectable for tests. */
export interface UserDataFileSystem {
  readonly isDirectory: (path: string) => boolean;
  readonly rename: (from: string, to: string) => void;
}

const nodeFileSystem: UserDataFileSystem = {
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  rename: renameSync,
};

/**
 * Decides which directory, if any, should be moved to `userData`. Pure.
 *
 * Returns `undefined` when the current directory already exists, when no
 * former name is present, or when the current directory *is* one of the
 * former names (an installation that has not been renamed yet).
 */
export function legacyUserDataDirectory(
  userData: string,
  isDirectory: (path: string) => boolean,
  legacyNames: readonly string[] = LEGACY_APP_NAMES,
): string | undefined {
  if (legacyNames.includes(basename(userData))) return undefined;
  if (isDirectory(userData)) return undefined;
  const parent = dirname(userData);
  return legacyNames.map((name) => join(parent, name)).find(isDirectory);
}

/**
 * Moves renderer preferences written under a former application name into
 * `userData`. Best effort: a failure costs preferences that the interface
 * recreates with its defaults, which must never stop the app from starting.
 *
 * @param userData the path reported by `app.getPath("userData")`
 */
export function adoptLegacyUserData(
  userData: string,
  fileSystem: UserDataFileSystem = nodeFileSystem,
): void {
  const legacy = legacyUserDataDirectory(userData, fileSystem.isDirectory);
  if (legacy === undefined) return;
  try {
    fileSystem.rename(legacy, userData);
  } catch {
    // Starting with default preferences beats refusing to start.
  }
}
