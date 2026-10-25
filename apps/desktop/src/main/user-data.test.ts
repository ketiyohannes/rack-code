import assert from "node:assert/strict";
import test from "node:test";

import { adoptLegacyUserData, legacyUserDataDirectory, type UserDataFileSystem } from "./user-data.js";

const SUPPORT = "/Users/u/Library/Application Support";
const CURRENT = `${SUPPORT}/rack`;
const PACKAGED_LEGACY = `${SUPPORT}/thinking-and-code`;
const DEVELOPMENT_LEGACY = `${SUPPORT}/Thinking and Code`;

function fakeFileSystem(existing: readonly string[], onRename?: () => void): {
  fileSystem: UserDataFileSystem;
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

test("a packaged build adopts the directory of the former application name", () => {
  const { fileSystem, renames } = fakeFileSystem([PACKAGED_LEGACY]);
  adoptLegacyUserData(CURRENT, fileSystem);
  assert.deepEqual(renames, [{ from: PACKAGED_LEGACY, to: CURRENT }]);
});

test("a development run adopts the differently cased former name", () => {
  const { fileSystem, renames } = fakeFileSystem([DEVELOPMENT_LEGACY]);
  adoptLegacyUserData(CURRENT, fileSystem);
  assert.deepEqual(renames, [{ from: DEVELOPMENT_LEGACY, to: CURRENT }]);
});

test("existing preferences are never replaced", () => {
  const { fileSystem, renames } = fakeFileSystem([CURRENT, PACKAGED_LEGACY]);
  adoptLegacyUserData(CURRENT, fileSystem);
  assert.deepEqual(renames, []);
});

test("a build still running under a former name is left alone", () => {
  const { fileSystem } = fakeFileSystem([PACKAGED_LEGACY]);
  assert.equal(legacyUserDataDirectory(PACKAGED_LEGACY, fileSystem.isDirectory), undefined);
});

test("nothing to adopt is not an error", () => {
  const { fileSystem, renames } = fakeFileSystem([]);
  adoptLegacyUserData(CURRENT, fileSystem);
  assert.deepEqual(renames, []);
});

test("a failed move leaves the app startable with default preferences", () => {
  const { fileSystem } = fakeFileSystem([PACKAGED_LEGACY], () => {
    throw new Error("EPERM");
  });
  assert.doesNotThrow(() => { adoptLegacyUserData(CURRENT, fileSystem); });
});
