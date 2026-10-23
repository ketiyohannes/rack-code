import assert from "node:assert/strict";
import test from "node:test";
import { QuestionBroker } from "./question-broker.js";
import type { RuntimeEvent, UserQuestion } from "./types.js";

const question: UserQuestion = { id: "format", question: "Which format?", options: [{ label: "Short" }, { label: "Long" }], multiSelect: false, allowCustom: false };

test("questions reject invalid or duplicate answers while retaining the unanswered request", async () => {
  const events: RuntimeEvent[] = [];
  const broker = new QuestionBroker(() => "request", async (event) => { events.push(event); });
  const answer = broker.request([question], new AbortController().signal);
  await assert.rejects(broker.respond("request", { answers: { format: ["Invented"] } }), /match/);
  await assert.rejects(broker.respond("request", { answers: {} }), /every question/);
  await broker.respond("request", { answers: { format: ["Long"] } });
  assert.deepEqual(await answer, { answers: { format: ["Long"] } });
  await assert.rejects(broker.respond("request", { answers: { format: ["Short"] } }), /no longer pending/);
  assert.deepEqual(events.map((event) => event.type), ["question_request", "question_resolved"]);
});

test("secret custom answers reach the runtime but are redacted from persisted/broadcast events", async () => {
  const events: RuntimeEvent[] = [];
  const broker = new QuestionBroker(() => "request", async (event) => { events.push(event); });
  const answer = broker.request([{ ...question, options: [], allowCustom: true, isSecret: true }], new AbortController().signal);
  await broker.respond("request", { answers: { format: ["private-answer"] } });
  assert.deepEqual(await answer, { answers: { format: ["private-answer"] } });
  assert.doesNotMatch(JSON.stringify(events), /private-answer/);
  assert.match(JSON.stringify(events), /redacted/);
});

test("abort and run shutdown dismiss questions without inventing answers or leaving waiters", async () => {
  let id = 0;
  const events: RuntimeEvent[] = [];
  const broker = new QuestionBroker(() => String(++id), async (event) => { events.push(event); });
  const controller = new AbortController();
  const first = broker.request([question], controller.signal);
  controller.abort();
  assert.equal(await first, null);
  const second = broker.request([question], new AbortController().signal);
  await broker.close();
  assert.equal(await second, null);
  assert.equal(await broker.request([question], new AbortController().signal), null);
  assert.equal(events.filter((event) => event.type === "question_resolved" && event.response === null).length, 2);
});

test("shutdown drains a native cancellation whose answer journal is still being written", async () => {
  let release!: () => void;
  const writing = new Promise<void>((resolve) => { release = resolve; });
  const broker = new QuestionBroker(() => "request", async (event) => {
    if (event.type === "question_resolved") await writing;
  });
  const controller = new AbortController();
  const answer = broker.request([question], controller.signal);
  controller.abort();
  let closed = false;
  const closing = broker.close().then(() => { closed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  await closing;
  assert.equal(await answer, null);
});
