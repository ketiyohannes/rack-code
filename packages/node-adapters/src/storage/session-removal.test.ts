import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionsService } from "@rack/core/sessions/service";
import { JsonSessionStore } from "./json-session-store.js";

test("removal persists across restarts and leaves sibling conversations intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rack-session-removal-"));
  try {
    const path = join(directory, "sessions.json");
    const sessions = new SessionsService(new JsonSessionStore(path));
    await sessions.create({ id: "removed", projectId: "project", title: "Remove me" });
    await sessions.create({ id: "kept", projectId: "project", title: "Keep me" });
    await sessions.appendMessage("kept", { role: "assistant", content: "Keep this history" });
    await sessions.remove("removed");
    const reopened = new SessionsService(new JsonSessionStore(path));
    assert.deepEqual((await reopened.list()).map((session) => session.id), ["kept"]);
    assert.equal((await reopened.get("kept")).messages[0]?.content, "Keep this history");
    await assert.rejects(reopened.get("removed"), /not found/);
    await assert.rejects(reopened.appendMessage("removed", { role: "user", content: "Cannot resurrect" }), /not found/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
