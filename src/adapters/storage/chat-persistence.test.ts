import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonSessionStore } from "./json-session-store.js";
import { JsonExecutionStore } from "./json-execution-store.js";
import { SessionsService } from "../../core/sessions/service.js";
import type { RunRecord } from "../../core/execution/types.js";

test("schema 3 upgrades preserve projects and new project-free chat histories reopen in schema 4", async () => {
  const root = await mkdtemp(join(tmpdir(), "rack-chat-storage-"));
  try {
    const timestamp = "2026-10-16T10:00:00Z";
    const old = { id: "old", projectId: "project", messages: [], continuations: [], createdAt: timestamp, updatedAt: timestamp };
    await writeFile(join(root, "sessions.json"), JSON.stringify({ schemaVersion: 3, sessions: [old] }));
    const sessions = new SessionsService(new JsonSessionStore(join(root, "sessions.json")));
    const chat = await sessions.create({ id: "chat" });
    await sessions.appendMessage(chat.id, { role: "user", content: "Discuss an idea" });
    const reopened = new SessionsService(new JsonSessionStore(join(root, "sessions.json")));
    assert.deepEqual(await reopened.get("old"), old);
    assert.equal((await reopened.get(chat.id)).projectId, undefined);
    assert.equal((await reopened.get(chat.id)).messages[0]!.content, "Discuss an idea");
    assert.equal((await reopened.get(chat.id)).originatedAsChat, true);
    assert.deepEqual((await reopened.list("project")).map((session) => session.id), ["old"]);
    const run: RunRecord = { id: "run", sessionId: "chat", prompt: "Plan", interactionMode: "plan", permissionMode: "full_access", providerId: "codex", accountId: "account", status: "completed", attemptIds: [], result: "A plan", createdAt: timestamp, updatedAt: timestamp };
    await writeFile(join(root, "execution.json"), JSON.stringify({ schemaVersion: 3, runs: [], attempts: [], journal: [] }));
    const executions = new JsonExecutionStore(join(root, "execution.json")); await executions.saveRun(run);
    assert.deepEqual(await new JsonExecutionStore(join(root, "execution.json")).getRun("run"), run);
    assert.equal((await executions.listRunUsage())[0]!.run.projectId, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
