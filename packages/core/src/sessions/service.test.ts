import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySessionStore } from "./in-memory-store.js";
import { afterRunSettled } from "./queue-policy.js";
import { SessionsService } from "./service.js";
import { MAX_QUEUED_MESSAGES, type QueuedRunSettings, type SessionQueue, type SessionRecord } from "./types.js";

/**
 * A store that yields between reading and writing, the way the JSON file
 * store does. Without per-session serialization, two concurrent writers
 * both read the same record and the later save drops the earlier change.
 */
class SlowSessionStore extends InMemorySessionStore {
  override async get(sessionId: string): Promise<SessionRecord | undefined> {
    const session = await super.get(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return session;
  }
}

const settings: QueuedRunSettings = { providerId: "fake", runtimeId: "fake-runtime", permissionMode: "ask" };

function setup(store = new InMemorySessionStore()) {
  let counter = 0;
  const sessions = new SessionsService(store, { now: () => new Date("2026-10-28T00:00:00.000Z"), createId: () => `id-${++counter}` });
  return { sessions, store };
}

test("concurrent writes to one session are serialized so none is lost", async () => {
  const { sessions } = setup(new SlowSessionStore());
  const session = await sessions.create({ id: "s", projectId: "p" });
  // Execution appends the reply and moves the thread marker while the user
  // edits the queue from another window.
  await Promise.all([
    sessions.appendMessage(session.id, { role: "assistant", content: "reply" }),
    sessions.enqueue(session.id, { prompt: "next", settings }),
    sessions.associateContinuation(session.id, { runtimeId: "fake-runtime", runtimeContextId: "ctx", nativeSessionId: "thread", seenThroughMessageId: "m" }),
    sessions.enqueue(session.id, { prompt: "after that", settings }),
  ]);
  const saved = await sessions.get(session.id);
  assert.deepEqual(saved.messages.map((message) => message.content), ["reply"]);
  assert.equal(saved.continuations.length, 1);
  assert.deepEqual(saved.queue?.items.map((item) => item.prompt), ["next", "after that"]);
});

test("a failed write releases the session lane for later writes", async () => {
  const { sessions } = setup();
  const session = await sessions.create({ id: "s", projectId: "p" });
  await assert.rejects(sessions.updateQueued(session.id, "missing", "text"), /already sent or removed/);
  await sessions.appendMessage(session.id, { role: "user", content: "still works" });
  assert.equal((await sessions.get(session.id)).messages.length, 1);
});

test("the queue keeps FIFO order through update, remove and take", async () => {
  const { sessions } = setup();
  const session = await sessions.create({ id: "s", projectId: "p" });
  const first = await sessions.enqueue(session.id, { prompt: "one", settings });
  const second = await sessions.enqueue(session.id, { prompt: "two", attachmentIds: ["file"], settings: { ...settings, skillIds: ["skill"] } });
  const third = await sessions.enqueue(session.id, { prompt: "three", settings });
  assert.deepEqual(second.settings.skillIds, ["skill"]);

  await sessions.updateQueued(session.id, third.id, "three, edited");
  await sessions.removeQueued(session.id, first.id);
  assert.deepEqual((await sessions.get(session.id)).queue?.items.map((item) => item.prompt), ["two", "three, edited"]);

  const head = await sessions.takeQueued(session.id);
  assert.equal(head?.id, second.id);
  assert.deepEqual(head?.attachmentIds, ["file"]);
  const named = await sessions.takeQueued(session.id, third.id);
  assert.equal(named?.prompt, "three, edited");
  // Nothing left: the field is dropped and taking again starts nothing.
  assert.equal((await sessions.get(session.id)).queue, undefined);
  assert.equal(await sessions.takeQueued(session.id), undefined);
});

test("queue validation rejects empty items, the limit, and stale item IDs", async () => {
  const { sessions } = setup();
  const session = await sessions.create({ id: "s", projectId: "p" });
  await assert.rejects(sessions.enqueue(session.id, { prompt: "   ", settings }), /text or an attachment/);
  // An attachment-only item is allowed, but its text cannot later be emptied if it has none.
  const onlyFile = await sessions.enqueue(session.id, { prompt: "", attachmentIds: ["file"], settings });
  await sessions.updateQueued(session.id, onlyFile.id, "");
  const text = await sessions.enqueue(session.id, { prompt: "text", settings });
  await assert.rejects(sessions.updateQueued(session.id, text.id, " "), /text or an attachment/);
  for (let index = 2; index < MAX_QUEUED_MESSAGES; index += 1) await sessions.enqueue(session.id, { prompt: `item ${index}`, settings });
  await assert.rejects(sessions.enqueue(session.id, { prompt: "one too many", settings }), new RegExp(`Up to ${MAX_QUEUED_MESSAGES}`));
  await sessions.removeQueued(session.id, text.id);
  await assert.rejects(sessions.removeQueued(session.id, text.id), /already sent or removed/);
  await assert.rejects(sessions.requestSendNow(session.id, text.id), /already sent or removed/);
});

test("pause, resume, Send now and restore keep the user's messages", async () => {
  const { sessions } = setup();
  const session = await sessions.create({ id: "s", projectId: "p" });
  // Pausing an empty queue has nothing to hold back.
  await sessions.pauseQueue(session.id, "run_failed");
  assert.equal((await sessions.get(session.id)).queue, undefined);

  const first = await sessions.enqueue(session.id, { prompt: "one", settings });
  const second = await sessions.enqueue(session.id, { prompt: "two", settings });
  await sessions.requestSendNow(session.id, second.id);
  assert.equal((await sessions.get(session.id)).queue?.sendNowItemId, second.id);
  // A pause supersedes a pending Send now.
  await sessions.pauseQueue(session.id, "start_failed", "Model unavailable.");
  let queue = (await sessions.get(session.id)).queue;
  assert.equal(queue?.pausedReason, "start_failed");
  assert.equal(queue?.pausedError, "Model unavailable.");
  assert.equal(queue?.sendNowItemId, undefined);

  await sessions.resumeQueue(session.id);
  queue = (await sessions.get(session.id)).queue;
  assert.equal(queue?.pausedReason, undefined);
  assert.equal(queue?.pausedError, undefined);

  // A failed start puts the item back at the head with its identity.
  const taken = await sessions.takeQueued(session.id);
  assert.equal(taken?.id, first.id);
  await sessions.restoreQueued(session.id, taken!);
  await sessions.restoreQueued(session.id, taken!);
  assert.deepEqual((await sessions.get(session.id)).queue?.items.map((item) => item.id), [first.id, second.id]);

  // Removing the item named by Send now clears the request.
  await sessions.requestSendNow(session.id, second.id);
  await sessions.removeQueued(session.id, second.id);
  assert.equal((await sessions.get(session.id)).queue?.sendNowItemId, undefined);
});

test("a host restart pauses every waiting queue and leaves empty ones alone", async () => {
  const { sessions } = setup();
  const waiting = await sessions.create({ id: "waiting", projectId: "p" });
  const idle = await sessions.create({ id: "idle", projectId: "p" });
  const failed = await sessions.create({ id: "failed", projectId: "p" });
  await sessions.enqueue(waiting.id, { prompt: "one", settings });
  await sessions.enqueue(failed.id, { prompt: "two", settings });
  await sessions.pauseQueue(failed.id, "run_failed");
  await sessions.pauseAllQueues("host_restarted");
  assert.equal((await sessions.get(waiting.id)).queue?.pausedReason, "host_restarted");
  assert.equal((await sessions.get(idle.id)).queue, undefined);
  // An existing reason is more informative than the restart.
  assert.equal((await sessions.get(failed.id)).queue?.pausedReason, "run_failed");
});

test("rewind cuts history at the first replaced turn and drops threads that saw it", async () => {
  const { sessions } = setup();
  const session = await sessions.create({ id: "s", projectId: "p" });
  await sessions.appendMessage(session.id, { id: "u1", role: "user", content: "first", metadata: { runId: "r1" } });
  await sessions.appendMessage(session.id, { id: "a1", role: "assistant", content: "reply 1", metadata: { runId: "r1" } });
  await sessions.appendMessage(session.id, { id: "u2", role: "user", content: "second", metadata: { runId: "r2" } });
  await sessions.appendMessage(session.id, { id: "a2", role: "assistant", content: "reply 2", metadata: { runId: "r2" } });
  await sessions.appendMessage(session.id, { id: "w1", role: "user", content: "workflow task", metadata: { workflowRunId: "w" } });
  // Codex last saw r1's reply; Claude saw through r2; a legacy entry has no position.
  await sessions.associateContinuation(session.id, { runtimeId: "codex", runtimeContextId: "c", nativeSessionId: "codex-thread", seenThroughMessageId: "a1" });
  await sessions.associateContinuation(session.id, { runtimeId: "claude", runtimeContextId: "c", nativeSessionId: "claude-thread", seenThroughMessageId: "a2" });
  await sessions.associateContinuation(session.id, { runtimeId: "legacy", runtimeContextId: "c", nativeSessionId: "legacy-thread" });
  await sessions.enqueue(session.id, { prompt: "waiting", settings });

  const rewound = await sessions.rewind(session.id, ["r2", "w"]);
  assert.deepEqual(rewound.messages.map((message) => message.id), ["u1", "a1"]);
  assert.deepEqual(rewound.continuations.map((continuation) => continuation.nativeSessionId), ["codex-thread"]);
  assert.deepEqual(rewound.supersededRunIds, ["r2", "w"]);
  // The queue is not part of the history and survives an edit.
  assert.equal(rewound.queue?.items.length, 1);

  // Replaced runs that never recorded a message remove nothing, and IDs accumulate without duplicates.
  const again = await sessions.rewind(session.id, ["r3", "w"]);
  assert.deepEqual(again.messages.map((message) => message.id), ["u1", "a1"]);
  assert.deepEqual(again.continuations.map((continuation) => continuation.nativeSessionId), ["codex-thread"]);
  assert.deepEqual(again.supersededRunIds, ["r2", "w", "r3"]);
});

test("editing the first message re-derives an automatic title and keeps a chosen one", async () => {
  const { sessions } = setup();
  const conversation = async (id: string, title?: string) => {
    await sessions.create({ id, projectId: "p", ...(title === undefined ? {} : { title }) });
    await sessions.appendMessage(id, { role: "user", content: "Fix   the\nlogin bug", metadata: { runId: `${id}-r1` } });
    await sessions.appendMessage(id, { role: "assistant", content: "done", metadata: { runId: `${id}-r1` } });
    await sessions.appendMessage(id, { role: "user", content: "and the tests", metadata: { runId: `${id}-r2` } });
    return id;
  };

  const automatic = await conversation("auto");
  assert.equal((await sessions.get(automatic)).title, "Fix the login bug");
  // Rewinding a later turn leaves the first message, and so the title, alone.
  assert.equal((await sessions.rewind(automatic, [`${automatic}-r2`])).title, "Fix the login bug");
  // Rewinding the first turn clears it; the edited prompt then sets the new one.
  assert.equal((await sessions.rewind(automatic, [`${automatic}-r1`])).title, undefined);
  await sessions.appendMessage(automatic, { role: "user", content: "Fix the signup bug", metadata: { runId: "auto-r3" } });
  assert.equal((await sessions.get(automatic)).title, "Fix the signup bug");

  // A title chosen at creation is not derived from the message and is kept.
  const chosen = await conversation("chosen", "Auth work");
  assert.equal((await sessions.rewind(chosen, [`${chosen}-r1`])).title, "Auth work");
  await sessions.appendMessage(chosen, { role: "user", content: "Fix the signup bug" });
  assert.equal((await sessions.get(chosen)).title, "Auth work");

  // A rewind that removes no message (the replaced run never recorded one) keeps the title.
  const untouched = await conversation("untouched");
  assert.equal((await sessions.rewind(untouched, ["never-recorded"])).title, "Fix the login bug");
});

test("the queue policy starts, pauses or waits after a run settles", () => {
  const item = (id: string) => ({ id, prompt: id, settings, createdAt: "t", updatedAt: "t" });
  const queue: SessionQueue = { items: [item("a"), item("b")] };
  assert.deepEqual(afterRunSettled("completed", undefined), { action: "none" });
  assert.deepEqual(afterRunSettled("failed", { items: [] }), { action: "none" });
  assert.deepEqual(afterRunSettled("completed", queue), { action: "start", itemId: "a" });
  assert.deepEqual(afterRunSettled("failed", queue), { action: "pause", reason: "run_failed" });
  assert.deepEqual(afterRunSettled("interrupted", queue), { action: "pause", reason: "run_interrupted" });
  assert.deepEqual(afterRunSettled("unknown", queue), { action: "pause", reason: "run_unknown" });
  assert.deepEqual(afterRunSettled("running", queue), { action: "none" });
  // Paused queues wait for the user.
  assert.deepEqual(afterRunSettled("completed", { ...queue, pausedReason: "run_failed" }), { action: "none" });
  // Send now wins over the outcome and over a pause.
  assert.deepEqual(afterRunSettled("interrupted", { ...queue, sendNowItemId: "b" }), { action: "start", itemId: "b" });
  assert.deepEqual(afterRunSettled("failed", { ...queue, sendNowItemId: "b", pausedReason: "run_failed" }), { action: "start", itemId: "b" });
  // A Send now whose item was removed falls back to the normal rule.
  assert.deepEqual(afterRunSettled("interrupted", { ...queue, sendNowItemId: "gone" }), { action: "pause", reason: "run_interrupted" });
});
