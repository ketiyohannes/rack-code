import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonFileDocument, replaceFileWithRetry } from "./json-file.js";

test("transient replacement errors retry the same staged file with bounded backoff", async () => {
  const waits: number[] = [];
  let calls = 0;
  await replaceFileWithRetry("staged", "saved", async (source, target) => {
    assert.equal(source, "staged"); assert.equal(target, "saved");
    const code = ["EPERM", "EBUSY", "EACCES"][calls++];
    if (code) throw Object.assign(new Error("busy"), { code });
  }, async (ms) => { waits.push(ms); });
  assert.equal(calls, 4);
  assert.deepEqual(waits, [20, 40, 80]);
});

test("permanent replacement failures preserve the original error and stop retrying", async () => {
  for (const code of ["EPERM", "ENOSPC", "ENOENT"]) {
    const failure = Object.assign(new Error("replacement failed"), { code });
    let calls = 0;
    const waits: number[] = [];
    await assert.rejects(replaceFileWithRetry("staged", "saved", async () => {
      calls++; throw failure;
    }, async (ms) => { waits.push(ms); }), (error) => error === failure);
    assert.equal(calls, code === "EPERM" ? 6 : 1);
    assert.equal(waits.reduce((sum, ms) => sum + ms, 0), code === "EPERM" ? 620 : 0);
  }
});

test("failed saves keep committed cache, clean staging files and allow subsequent updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rack-json-recovery-"));
  const file = join(directory, "state.json");
  try {
    const document = new JsonFileDocument(file, { count: 0 });
    await document.read();
    // Force replacement failure portably, without changing filesystem ACLs.
    await unlink(file);
    await mkdir(file);
    let mutations = 0;
    await assert.rejects(document.update((value) => { mutations++; return { count: value.count + 10 }; }));
    assert.equal(mutations, 1);
    assert.equal((await document.read()).count, 0);
    assert.deepEqual(await readdir(directory), ["state.json"]);
    await rm(file, { recursive: true });
    await writeFile(file, JSON.stringify({ count: 0 }));
    await document.update((value) => ({ count: value.count + 1 }));
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { count: 1 });
    assert.equal((await new JsonFileDocument(file, { count: -1 }).read()).count, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("queued mutations remain ordered and reads cannot see uncommitted changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rack-json-order-"));
  try {
    const document = new JsonFileDocument(join(directory, "state.json"), { count: 0 });
    await document.read();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = document.update(async (value) => { started(); await blocked; return { count: value.count + 1 }; });
    await entered;
    const second = document.update((value) => ({ count: value.count + 1 }));
    assert.equal((await document.read()).count, 0);
    release();
    assert.equal((await first).count, 1);
    assert.equal((await second).count, 2);
    assert.equal((await document.read()).count, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
