/** Optimized capture must keep the original ignore/index semantics. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitSnapshotRepository } from "./git-snapshots.js";
import { hasVisibleChanges } from "./fs-watcher.js";

test("cached private indexes retain edits, deletions and newly ignored/unignored files without changing user index", async () => {
  const root = await mkdtemp(join(tmpdir(), "rack-index-cache-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "--quiet");
    await writeFile(join(root, "file.txt"), "one\n");
    git("add", ".");
    const userIndex = await readFile(join(root, ".git/index"));
    const snapshots = new GitSnapshotRepository();
    const input = { projectPath: root, ref: "refs/rack-project-timeline/test", label: "Test", trailers: {} };
    const first = await snapshots.capture(input);
    assert.equal((await snapshots.capture(input)).kind, "unchanged");
    await writeFile(join(root, "file.txt"), "two\n");
    const changed = await snapshots.capture(input);
    assert.notEqual(changed.snapshot, first.snapshot);
    await writeFile(join(root, ".gitignore"), "file.txt\n");
    const ignored = await snapshots.capture(input);
    assert.ok(!(await snapshots.tree(root, ignored.snapshot)).includes("file.txt"));
    assert.equal(await hasVisibleChanges(root, ["file.txt"]), false);
    assert.equal(await hasVisibleChanges(root, ["file.txt", "source.ts"]), true);
    await writeFile(join(root, ".gitignore"), "");
    const visible = await snapshots.capture(input);
    assert.ok((await snapshots.tree(root, visible.snapshot)).includes("file.txt"));
    await rm(join(root, "file.txt"));
    const removed = await snapshots.capture(input);
    assert.ok(!(await snapshots.tree(root, removed.snapshot)).includes("file.txt"));
    await mkdir(join(root, "build")); await writeFile(join(root, ".gitignore"), "build/\n");
    assert.equal(await hasVisibleChanges(root, ["build/output.js"]), false);
    assert.deepEqual(await readFile(join(root, ".git/index")), userIndex);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an edit made while the previous capture was indexing is still recorded", async () => {
  const root = await mkdtemp(join(tmpdir(), "rack-index-racy-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet"]);
    const file = join(root, "file.txt");
    const snapshots = new GitSnapshotRepository();
    const input = { projectPath: root, ref: "refs/rack-project-timeline/racy", label: "Test", trailers: {} };

    // Git decides a file is unchanged when its size and modification time
    // still match the index entry, so both contents are the same length and
    // the time is pinned: content alone must not be what gives the edit
    // away. The pin is set slightly ahead of the capture that records it,
    // which is what an edit landing in the same second as a capture looks
    // like to Git. Pinning keeps this deterministic on builds with
    // nanosecond stat support, where the real window is a few microseconds
    // wide and cannot be hit on purpose.
    const indexedAt = new Date(Date.now() + 1000);
    await writeFile(file, "before\n");
    await utimes(file, indexedAt, indexedAt);
    const first = await snapshots.capture(input);
    assert.equal(first.kind, "created");

    await writeFile(file, "after!\n");
    await utimes(file, indexedAt, indexedAt);
    // Capture once that moment is past, so the cached index is the only
    // reason the second capture could believe nothing changed.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const second = await snapshots.capture(input);
    assert.equal(second.kind, "created", "the edit must be recorded, not read from stale stat data");
    assert.notEqual(second.snapshot, first.snapshot);
  } finally { await rm(root, { recursive: true, force: true }); }
});
