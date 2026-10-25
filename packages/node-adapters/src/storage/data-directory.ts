/**
 * Where Rack keeps its local records, and how a directory written under the
 * product's former name is adopted.
 *
 * The application was released as "Thinking and Code" and stored everything
 * in `~/.thinking-and-code`: projects, saved sessions, account records and
 * the per-account runtime context directories that providers log in to.
 * Renaming the product cannot abandon that directory, because starting a
 * renamed application against an empty one looks exactly like losing the
 * work.
 *
 * Two functions, deliberately separate:
 *
 * - `defaultDataDirectory()` is a pure path. Composition and argument
 *   parsing use it, so importing them performs no file system work and a
 *   test never touches a real home directory.
 * - `adoptLegacyDataDirectory()` performs the one-time move and is called
 *   by the processes that start a host, before anything opens a record.
 *
 * The move happens only when the new directory does not exist yet, so a user
 * who already runs the renamed application keeps their current records and
 * an older installation's leftovers are never merged into them. Both paths
 * are siblings in the home directory, so the rename stays within one file
 * system. When it fails anyway — a permission the user has since changed, a
 * directory held open by another process — the legacy path is returned and
 * used as-is. An application that keeps working from the old location is a
 * better answer than one that starts empty.
 */
import { renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Directory name under the user's home directory. */
export const DATA_DIRECTORY_NAME = ".rack";

/** The name used before the product was renamed to Rack. */
export const LEGACY_DATA_DIRECTORY_NAME = ".thinking-and-code";

/** The default record location. Pure: no file system access. */
export function defaultDataDirectory(home: string = homedir()): string {
  return join(home, DATA_DIRECTORY_NAME);
}

/** File system operations used by {@link adoptLegacyDataDirectory}. */
export interface DataDirectoryFileSystem {
  readonly isDirectory: (path: string) => boolean;
  readonly rename: (from: string, to: string) => void;
}

const nodeFileSystem: DataDirectoryFileSystem = {
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
 * Returns the directory a host should use, moving records written under the
 * former product name into it first when that is both needed and possible.
 *
 * Idempotent: once the new directory exists this is a single `stat`.
 *
 * @param home the user's home directory; injectable for tests
 * @param fileSystem the operations to use; injectable for tests
 */
export function adoptLegacyDataDirectory(
  home: string = homedir(),
  fileSystem: DataDirectoryFileSystem = nodeFileSystem,
): string {
  const directory = defaultDataDirectory(home);
  if (fileSystem.isDirectory(directory)) return directory;
  const legacy = join(home, LEGACY_DATA_DIRECTORY_NAME);
  if (!fileSystem.isDirectory(legacy)) return directory;
  try {
    fileSystem.rename(legacy, directory);
    return directory;
  } catch {
    // Keep serving the records that exist rather than starting empty.
    return legacy;
  }
}
