import assert from "node:assert/strict";
import test from "node:test";
import { TerminalService, type TerminalBackend } from "./index.js";
import type { TerminalStart } from "@rack/core/execution/terminal";

function backend() {
  const inputs: TerminalStart[] = [];
  const writes: string[] = [];
  const sizes: number[][] = [];
  let closes = 0;
  const driver: TerminalBackend = { label: "Test PTY", start: async (input) => {
    inputs.push(input);
    return { write: async (data) => { writes.push(data); }, resize: async (cols, rows) => { sizes.push([cols, rows]); }, close: async () => { closes++; } };
  } };
  return { driver, inputs, writes, sizes, closes: () => closes };
}

test("terminal contexts reconnect without duplicate processes and keep bounded output offsets", async () => {
  const fake = backend();
  const terminals = new TerminalService(fake.driver);
  const [first, second] = await Promise.all([terminals.open("session:a", "/project", 80, 24), terminals.open("session:a", "/project", 90, 30)]);
  assert.equal(first.id, second.id);
  assert.equal(fake.inputs.length, 1);
  fake.inputs[0]!.onData("x".repeat(300_000));
  const output = terminals.read(first.id);
  assert.equal(output.start, 300_000 - 262_144);
  assert.equal(output.output.length, 262_144);
  fake.inputs[0]!.onData("tail");
  assert.equal(terminals.read(first.id, output.offset).output, "tail");
  await terminals.shutdown();
  assert.equal(fake.closes(), 1);
});

test("terminal input, resize, exit and repeated close retain their native semantics", async () => {
  const fake = backend();
  const terminals = new TerminalService(fake.driver);
  const opened = await terminals.open("project:a", "/project", 80, 24);
  await Promise.all([terminals.write(opened.id, "one"), terminals.write(opened.id, "two")]);
  await terminals.resize(opened.id, 100, 35);
  assert.deepEqual(fake.writes, ["one", "two"]);
  assert.deepEqual(fake.sizes, [[100, 35]]);
  fake.inputs[0]!.onExit(7);
  assert.equal(terminals.read(opened.id).exitCode, 7);
  await assert.rejects(terminals.write(opened.id, "three"), /exited/);
  await Promise.all([terminals.close(opened.id), terminals.close(opened.id)]);
  await terminals.close(opened.id);
  assert.throws(() => terminals.read(opened.id), /not available/);
});

test("unsupported native startup falls back once and ignores late native callbacks", async () => {
  const fake = backend();
  let old!: TerminalStart;
  const native: TerminalBackend = { label: "Unsupported", start: async (input) => { old = input; throw new Error("unsupported"); } };
  const terminals = new TerminalService(fake.driver);
  const opened = await terminals.open("session:a", "/project", 80, 24, native);
  old.onExit(1); old.onData("stale");
  fake.inputs[0]!.onData("local");
  assert.equal(terminals.read(opened.id).output, "local");
  assert.equal(terminals.read(opened.id).exited, false);
  assert.equal(opened.backend, "Test PTY");
  await terminals.shutdown();
});

test("closeContext and shutdown wait for pending startups and refuse new shells", async () => {
  const fake = backend();
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const terminals = new TerminalService({ label: "Delayed", start: async (input) => { await ready; return fake.driver.start(input); } });
  const opening = terminals.open("session:a", "/project", 80, 24);
  const closing = terminals.closeContext("session:a");
  release();
  const opened = await opening;
  await closing;
  assert.throws(() => terminals.read(opened.id), /not available/);
  await terminals.shutdown();
  await assert.rejects(terminals.open("session:b", "/project", 80, 24), /shutting down/);
});

test("terminal capacity includes pending starts and is released after failed startup", async () => {
  const fake = backend();
  const terminals = new TerminalService(fake.driver);
  const opened = await Promise.all(Array.from({ length: 12 }, (_, index) => terminals.open(`session:${index}`, "/project", 80, 24)));
  await assert.rejects(terminals.open("overflow", "/project", 80, 24), /12 maximum/);
  await terminals.close(opened[0]!.id);
  await terminals.open("replacement", "/project", 80, 24);
  await terminals.shutdown();
  assert.equal(fake.closes(), 13);
});
