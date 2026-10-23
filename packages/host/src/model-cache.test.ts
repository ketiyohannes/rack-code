import assert from "node:assert/strict";
import test from "node:test";
import { ModelCatalogCache } from "./model-cache.js";

test("model discoveries share results, bound concurrent processes and invalidate on reconnect", async () => {
  const cache = new ModelCatalogCache();
  const finish: (() => void)[] = [];
  let started = 0;
  const discover = () => { started++; return new Promise<[]>(resolve => finish.push(() => resolve([]))); };
  const first = cache.get("one", discover);
  assert.equal(cache.get("one", discover), first);
  const second = cache.get("two", discover);
  const third = cache.get("three", discover);
  assert.equal(started, 2);
  finish.shift()!(); await first;
  assert.equal(started, 3);
  finish.shift()!(); finish.shift()!(); await Promise.all([second, third]);
  await cache.get("one", discover); assert.equal(started, 3);
  cache.clear();
  const fresh = cache.get("one", discover); assert.equal(started, 4); finish.shift()!(); await fresh;
  await assert.rejects(cache.get("bad", async () => { throw new Error("unavailable"); }));
  assert.deepEqual(await cache.get("bad", async () => []), []);
});

test("a burst of pending model contexts is bounded once discovery settles", async () => {
  const cache = new ModelCatalogCache();
  let calls = 0;
  const discover = async () => { calls++; return []; };
  await Promise.all(Array.from({ length: 40 }, (_, index) => cache.get(String(index), discover)));
  assert.equal(calls, 40);
  await cache.get("39", discover);
  assert.equal(calls, 40, "recent contexts remain cached");
  await cache.get("0", discover);
  assert.equal(calls, 41, "oldest settled context was evicted");
});

test("stale reads answer from the last good catalog while discovery refreshes", async () => {
  const cache = new ModelCatalogCache();
  const model = (id: string) => ({ id, label: id, providerId: "p" });
  await cache.get("key", async () => [model("old")]);
  cache.clear();
  // Nothing known yet after clear: a stale read must still wait for discovery.
  assert.deepEqual((await cache.get("key", async () => [model("first")], { allowStale: true })).map((entry) => entry.id), ["first"]);
  let release!: () => void;
  const slow = new Promise<void>((resolve) => { release = resolve; });
  const realNow = Date.now;
  Date.now = () => realNow() + 120_000;
  try {
    const stale = await cache.get("key", async () => { await slow; return [model("fresh")]; }, { allowStale: true });
    assert.deepEqual(stale.map((entry) => entry.id), ["first"]);
    release();
    assert.deepEqual((await cache.get("key", async () => [model("unused")])).map((entry) => entry.id), ["fresh"]);
  } finally { Date.now = realNow; }
});
