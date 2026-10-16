import assert from "node:assert/strict";
import test from "node:test";
import { UsageService } from "./index.js";
import { InMemoryExecutionStore } from "../../core/execution/in-memory-store.js";
import type { RunRecord } from "../../core/execution/types.js";
const run: RunRecord = { id: "r1", sessionId: "removed-session", projectId: "p1", accountId: "a", providerId: "provider", model: "model", permissionMode: "ask", prompt: "private", status: "completed", attemptIds: ["a1", "a2"], createdAt: "2026-10-16T10:00:00Z", updatedAt: "2026-10-16T11:00:00Z" };
test("usage aggregates latest cumulative fields per attempt, missing observations and UTC dates", async () => {
  const store = new InMemoryExecutionStore();
  await store.saveRun(run); await store.saveRun({ ...run, id: "r2", projectId: "p2", status: "failed" });
  for (const [attemptId, payload] of [["a1", { inputTokens: 10, outputTokens: 2 }], ["a1", { inputTokens: 20, outputTokens: 5, costUsd: .2 }], ["a1", { inputTokens: -1 }], ["a2", { inputTokens: 3, costUsd: .1 }]] as const) {
    await store.appendJournal({ runId: "r1", attemptId, type: "usage", payload, observedAt: run.createdAt });
  }
  await store.appendJournal({ runId: "r1", attemptId: "a1", type: "message_delta", payload: { text: "private" }, observedAt: run.createdAt });
  assert.doesNotMatch(JSON.stringify(await store.listRunUsage()), /private|prompt|message_delta/);
  const usage = new UsageService(() => store.listRunUsage(), () => new Date("2026-10-16T12:00:00Z"));
  const report = await usage.report({ days: 7 });
  assert.equal(report.totals.runs, 2); assert.equal(report.totals.completed, 1); assert.equal(report.totals.failed, 1);
  assert.equal(report.totals.inputTokens, 23); assert.equal(report.totals.outputTokens, 5); assert.equal(report.totals.tokenRuns, 1); assert.equal(report.totals.costRuns, 1);
  assert.equal(report.daily.length, 7); assert.equal(report.daily.at(-1)?.day, "2026-10-16"); assert.equal(report.daily.at(-1)?.runs, 2);
  assert.equal((await usage.report({ days: 1, projectId: "p2" })).totals.tokenRuns, 0);
  assert.doesNotMatch(JSON.stringify(report), /private|prompt|removed-session/);
});
