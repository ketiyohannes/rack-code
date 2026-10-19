/** A fresh host must reconcile durable records left behind by a killed process. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../../composition/application.js";
import { JsonExecutionStore } from "../../adapters/storage/json-execution-store.js";
import { HostApi } from "./host-api.js";
import { ActiveRuns } from "./active-runs.js";
import { AsyncQueue } from "../../core/shared/async-queue.js";
import type { RunView } from "../../contracts/desktop/views.js";
import type { RuntimeEvent } from "../../core/execution/types.js";
const stamp = "2026-10-16T00:00:00.000Z";

test("restart settles orphaned runs/attempts once, releases even orphaned locks and allows deletion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rack-restart-"));
  try {
    const prior = createApplication({ dataDirectory: directory, timeline: false });
    const project = await prior.projects.createProject({ path: directory });
    const session = await prior.sessions.create({ projectId: project.id });
    await prior.projects.acquireWriter(project.id, "attempt", { sessionId: session.id, mode: "shared" });
    const orphan = await prior.projects.createProject({ path: join(directory, "orphan") });
    await prior.projects.acquireWriter(orphan.id, "unrecorded-attempt", { sessionId: "orphan-session", mode: "shared" });
    const store = new JsonExecutionStore(join(directory, "execution.json"));
    const run = { id: "old-run", sessionId: session.id, projectId: project.id, prompt: "work", providerId: "fake", accountId: "account", permissionMode: "ask" as const, status: "running" as const, attemptIds: ["attempt"], createdAt: stamp, updatedAt: stamp };
    await store.saveRun(run);
    await store.saveRun({ ...run, id: "done-run", attemptIds: [], status: "completed", result: "keep this result" });
    await store.saveAttempt({ id: "attempt", runId: run.id, runtimeId: "fake", providerId: "fake", accountId: "account", status: "running", nativeSessionId: "saved-thread", createdAt: stamp, updatedAt: stamp });
    await store.appendJournal({ runId: run.id, attemptId: "attempt", type: "message_delta", payload: { type: "message_delta", text: "preserved partial output" }, observedAt: stamp });
    const app = createApplication({ dataDirectory: directory, timeline: false });
    const api = new HostApi(app, () => {});
    const response = await api.dispatch("runs.list", { sessionId: session.id });
    assert.ok(response.ok);
    const runs = response.value as RunView[];
    assert.equal(runs.find((entry) => entry.id === run.id)?.status, "unknown");
    assert.equal(runs.find((entry) => entry.id === run.id)?.attempts[0]?.status, "unknown");
    assert.equal(runs.find((entry) => entry.id === run.id)?.attempts[0]?.nativeSessionId, "saved-thread");
    assert.equal(runs.find((entry) => entry.id === "done-run")?.result, "keep this result");
    assert.equal((await app.projects.getProject(project.id)).activeWriterAttemptId, undefined);
    assert.equal((await app.projects.getProject(orphan.id)).activeWriterAttemptId, undefined);
    const journal = await app.execution.listJournal(run.id);
    assert.match(JSON.stringify(journal), /preserved partial output/);
    assert.equal(journal.filter((entry) => entry.type === "run_status").length, 1);
    await app.execution.initialize();
    const another = createApplication({ dataDirectory: directory, timeline: false });
    await another.execution.initialize();
    assert.equal((await another.execution.listJournal(run.id)).filter((entry) => entry.type === "run_status").length, 1);
    assert.ok((await api.dispatch("sessions.remove", { sessionId: session.id })).ok);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("shutdown's deadline includes a provider cancellation that never resolves", { timeout: 1500 }, async () => {
  const active = new ActiveRuns({ emit: () => {}, loadRun: async () => run });
  const run: RunView = { id: "r", sessionId: "s", projectId: "p", providerId: "fake", accountId: "a", prompt: "wait", permissionMode: "ask", status: "running", attemptIds: [], attempts: [], createdAt: stamp, updatedAt: stamp };
  active.track({ runId: run.id, attemptId: "attempt", events: new AsyncQueue<RuntimeEvent>(), completed: new Promise(() => {}), respondToApproval: () => {}, cancel: () => new Promise(() => {}) }, run);
  const start = Date.now();
  assert.equal(await active.cancelAll(25), 1);
  assert.ok(Date.now() - start < 1000);
});

test("failed final persistence still removes the live handle and reports unknown rather than loading", async () => {
  const events: import("../../contracts/desktop/events.js").HostEvent[] = [];
  const active = new ActiveRuns({ emit: (event) => events.push(event), loadRun: async () => { throw new Error("Storage unavailable"); } });
  const run: RunView = { id: "failed-save", sessionId: "s", projectId: "p", providerId: "fake", accountId: "a", prompt: "work", permissionMode: "ask", status: "running", attemptIds: [], attempts: [], createdAt: stamp, updatedAt: stamp };
  const queue = new AsyncQueue<RuntimeEvent>(); queue.complete();
  active.track({ runId: run.id, attemptId: "attempt", events: queue, completed: Promise.reject(new Error("Storage unavailable")), respondToApproval: () => {}, cancel: async () => {} }, run);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(active.list(), []);
  assert.ok(events.some((event) => event.type === "run.finished" && event.run.status === "unknown"));
});
