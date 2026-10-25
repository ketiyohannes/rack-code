import assert from "node:assert/strict";
import test from "node:test";

import {
  DATA_DIRECTORY_NAME,
  LEGACY_DATA_DIRECTORY_NAME,
  adoptLegacyDataDirectory,
  defaultDataDirectory,
  type DataDirectoryFileSystem,
} from "./data-directory.js";

const HOME = "/home/user";
const CURRENT = `${HOME}/${DATA_DIRECTORY_NAME}`;
const LEGACY = `${HOME}/${LEGACY_DATA_DIRECTORY_NAME}`;

/** Records renames so each test can assert whether one happened. */
function fakeFileSystem(existing: readonly string[], onRename?: () => void): {
  fileSystem: DataDirectoryFileSystem;
  renames: { from: string; to: string }[];
} {
  const directories = new Set(existing);
  const renames: { from: string; to: string }[] = [];
  return {
    renames,
    fileSystem: {
      isDirectory: (path) => directories.has(path),
      rename: (from, to) => {
        onRename?.();
        renames.push({ from, to });
        directories.delete(from);
        directories.add(to);
      },
    },
  };
}

test("the default location is a pure path under the home directory", () => {
  assert.equal(defaultDataDirectory(HOME), CURRENT);
});

test("records written under the former product name are moved once", () => {
  const { fileSystem, renames } = fakeFileSystem([LEGACY]);
  assert.equal(adoptLegacyDataDirectory(HOME, fileSystem), CURRENT);
  assert.deepEqual(renames, [{ from: LEGACY, to: CURRENT }]);
  // Idempotent: the second start finds the current directory and stops.
  assert.equal(adoptLegacyDataDirectory(HOME, fileSystem), CURRENT);
  assert.equal(renames.length, 1);
});

test("an existing current directory is never overwritten by leftovers", () => {
  const { fileSystem, renames } = fakeFileSystem([CURRENT, LEGACY]);
  assert.equal(adoptLegacyDataDirectory(HOME, fileSystem), CURRENT);
  assert.deepEqual(renames, [], "the user's current records win");
});

test("a first run with nothing to adopt reports the current directory", () => {
  const { fileSystem, renames } = fakeFileSystem([]);
  assert.equal(adoptLegacyDataDirectory(HOME, fileSystem), CURRENT);
  assert.deepEqual(renames, []);
});

test("a failed move keeps using the legacy directory instead of starting empty", () => {
  const { fileSystem } = fakeFileSystem([LEGACY], () => {
    throw new Error("EPERM");
  });
  assert.equal(adoptLegacyDataDirectory(HOME, fileSystem), LEGACY);
});
