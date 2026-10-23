/** Durable log regression checks: migration, detached indexed reads, concurrent
 * ordering and interrupted appends must preserve execution audit history. */
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonExecutionStore } from "./json-execution-store.js";
const event = { runId: "run", attemptId: "attempt", type: "message_delta", payload: { type: "message_delta", text: "Hello" }, observedAt: "2026-10-19T00:00:00Z" } as const;

test("execution log migrates once, appends bounded records and indexes detached run histories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rack-log-"));
  try {
    const path = join(dir, "execution.json");
    const history = Array.from({ length: 1000 }, (_, i) => ({ ...event, sequence: i + 1, runId: i % 2 ? "other" : "run" }));
    const legacy = JSON.stringify({ schemaVersion: 4, runs: [], attempts: [], journal: history });
    await writeFile(path, legacy);
    const store = new JsonExecutionStore(path);
    assert.equal((await store.listJournal("run")).length, 500);
    const before = (await stat(`${path}.log`)).size;
    const entries = await Promise.all(Array.from({ length: 20 }, () => store.appendJournal(event)));
    assert.deepEqual(entries.map((entry) => entry.sequence), Array.from({ length: 20 }, (_, i) => 1001 + i));
    assert.ok((await stat(`${path}.log`)).size - before < 10_000, "writes only new events");
    assert.equal(await readFile(path, "utf8"), legacy, "legacy backup is untouched");
    (entries[0]!.payload as { text: string }).text = "client mutation";
    assert.equal(((await store.listJournal("run")).at(-20)!.payload as { text: string }).text, "Hello");
    assert.equal((await new JsonExecutionStore(path).listJournal("run")).length, 520);
    // Once migrated, reopening must not depend on or regress to the backup.
    await writeFile(path, "invalid old backup");
    assert.equal((await new JsonExecutionStore(path).listJournal("other")).length, 500);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("execution log drops only an incomplete tail and preserves sequence after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rack-log-tail-"));
  try {
    const path = join(dir, "execution.json");
    await new JsonExecutionStore(path).appendJournal(event);
    const size = (await stat(`${path}.log`)).size;
    await appendFile(`${path}.log`, '{"transaction":{"journal":[{"text":"partial');
    const reopened = new JsonExecutionStore(path);
    assert.equal((await reopened.listJournal("run")).length, 1);
    assert.equal((await stat(`${path}.log`)).size, size);
    assert.equal((await reopened.appendJournal(event)).sequence, 2);
    await appendFile(`${path}.log`, 'invalid committed record\n');
    await assert.rejects(new JsonExecutionStore(path).listJournal("run"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
