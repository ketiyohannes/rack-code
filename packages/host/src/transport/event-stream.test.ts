import assert from "node:assert/strict";
import test from "node:test";

import type { HostEvent } from "@rack/contracts/events";

import { EventStream } from "./event-stream.js";

const event = (sessionId: string): HostEvent => ({ type: "sessions.changed", sessionId });

test("events are sequenced from one and fanned out to every subscriber", () => {
  const stream = new EventStream();
  const first: number[] = [];
  const second: number[] = [];
  const stop = stream.subscribe((entry) => first.push(entry.sequence));
  stream.subscribe((entry) => second.push(entry.sequence));

  assert.equal(stream.cursor, 1, "a fresh stream has published nothing");
  assert.equal(stream.publish(event("a")).sequence, 1);
  assert.equal(stream.publish(event("b")).sequence, 2);
  stop();
  stream.publish(event("c"));

  assert.deepEqual(first, [1, 2], "an unsubscribed listener stops receiving");
  assert.deepEqual(second, [1, 2, 3]);
  assert.equal(stream.cursor, 4);
});

test("a throwing subscriber cannot stop delivery to the others", () => {
  const stream = new EventStream();
  const delivered: number[] = [];
  stream.subscribe(() => {
    throw new Error("this connection died mid-write");
  });
  stream.subscribe((entry) => delivered.push(entry.sequence));

  assert.doesNotThrow(() => stream.publish(event("a")));
  assert.deepEqual(delivered, [1]);
});

test("a buffered gap is replayed in order and nothing already seen is resent", () => {
  const stream = new EventStream({ bufferSize: 10 });
  for (const id of ["a", "b", "c"]) stream.publish(event(id));

  const replay = stream.since(1);
  assert.equal(replay.status, "replayed");
  assert.deepEqual(
    replay.status === "replayed" ? replay.events.map((entry) => entry.sequence) : [],
    [2, 3],
    "resuming from 1 returns only what followed it",
  );

  const upToDate = stream.since(3);
  assert.equal(upToDate.status, "replayed");
  assert.deepEqual(upToDate.status === "replayed" ? upToDate.events : [], [], "a caught-up client gets nothing");

  const fromNothing = stream.since(0);
  assert.equal(fromNothing.status, "replayed");
  assert.equal(fromNothing.status === "replayed" ? fromNothing.events.length : -1, 3, "cursor 0 means nothing was seen");
});

test("a gap older than the buffer reports truncation instead of a silent hole", () => {
  const stream = new EventStream({ bufferSize: 2 });
  for (const id of ["a", "b", "c", "d"]) stream.publish(event(id));

  // Events 1 and 2 were evicted, so resuming from 1 cannot be satisfied.
  assert.equal(stream.since(1).status, "truncated");
  // The buffer still holds 3 and 4, so resuming from 2 is exact.
  const replay = stream.since(2);
  assert.equal(replay.status, "replayed");
  assert.deepEqual(replay.status === "replayed" ? replay.events.map((entry) => entry.sequence) : [], [3, 4]);
});

test("a cursor from a different stream is truncation, not an empty replay", () => {
  const stream = new EventStream();
  stream.publish(event("a"));

  // A controller resuming against a daemon that restarted holds sequence
  // numbers from a dead stream. Answering "nothing new" would leave it
  // permanently stale; it must be told to re-read state.
  assert.equal(stream.since(99).status, "truncated");
  assert.equal(stream.since(-1).status, "truncated");
  assert.equal(stream.since(1.5).status, "truncated");
});

test("an empty buffer only satisfies a client that is already current", () => {
  const stream = new EventStream({ bufferSize: 1 });
  // A new client against a daemon that has published nothing is genuinely
  // up to date, so this is an empty replay rather than truncation.
  const fresh = stream.since(0);
  assert.equal(fresh.status, "replayed");
  assert.deepEqual(fresh.status === "replayed" ? fresh.events : [], []);

  // With a one-event buffer, event 1 is evicted as soon as 2 arrives.
  stream.publish(event("a"));
  stream.publish(event("b"));
  assert.equal(stream.since(0).status, "truncated", "the only gap it could need was evicted");
  assert.equal(stream.since(1).status, "replayed", "the retained event still covers this cursor");
});

test("the buffer size must be a positive integer", () => {
  assert.throws(() => new EventStream({ bufferSize: 0 }), RangeError);
  assert.throws(() => new EventStream({ bufferSize: -1 }), RangeError);
});
