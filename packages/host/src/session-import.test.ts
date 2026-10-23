import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createApplication } from "./composition/application.js";
import { HostApi } from "./host-api.js";
import type { LocalSessionSource } from "@rack/core/session-imports/ports";

/** Exercises the public desktop boundary and durable reload, without provider credentials. */
test("desktop discovers, previews, imports, and reloads one external session without executing work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rack-import-host-"));
  try {
    const date = "2026-10-14T00:00:00.000Z";
    const native = { sourceId: "fake-local", providerName: "Fake", nativeSessionId: "native-id", projectPath: "/tmp/project",
      title: "Existing work", createdAt: date, updatedAt: date };
    const source: LocalSessionSource = {
      sourceId: native.sourceId, providerName: native.providerName,
      list: async () => [native],
      read: async () => ({ session: native, messages: [
        { role: "user", content: "Original task" }, { role: "assistant", content: "Original answer" },
        ...Array.from({ length: 15 }, () => ({ role: "tool" as const, content: "Old tool output" })),
      ] }),
    };
    const app = createApplication({ dataDirectory: directory, connectors: [], sessionSources: [source] });
    const host = new HostApi(app, () => {});
    const project = await app.projects.createProject({ path: native.projectPath });
    const input = { projectId: project.id, sourceId: source.sourceId, nativeSessionId: native.nativeSessionId };
    const discovery = await host.dispatch("sessions.discover", { projectId: project.id });
    assert.ok(discovery.ok);
    assert.equal((discovery.value as { sessions: unknown[] }).sessions.length, 1);
    const preview = await host.dispatch("sessions.previewImport", input);
    assert.ok(preview.ok);
    assert.equal((preview.value as { messages: unknown[] }).messages.length, 2);
    const imported = await host.dispatch("sessions.import", input);
    assert.ok(imported.ok);
    const value = imported.value as { session: { id: string }; alreadyImported: boolean };
    assert.equal(value.alreadyImported, false);
    const duplicate = await host.dispatch("sessions.import", input);
    assert.ok(duplicate.ok);
    assert.equal((duplicate.value as typeof value).session.id, value.session.id);
    assert.equal((duplicate.value as typeof value).alreadyImported, true);
    const reloaded = createApplication({ dataDirectory: directory, connectors: [], sessionSources: [] });
    const saved = await reloaded.sessions.get(value.session.id);
    assert.equal(saved.projectId, project.id);
    assert.equal(saved.importSource?.nativeSessionId, native.nativeSessionId);
    assert.equal(saved.messages.length, 17);
    assert.equal(saved.messages[1]?.content, "Original answer");
    assert.deepEqual(saved.continuations, []);
    assert.deepEqual(await reloaded.execution.listRuns(saved.id), []);
    assert.equal((await reloaded.sessions.list(project.id)).length, 1);
    const unknownSource = await host.dispatch("sessions.import", { ...input, sourceId: "unknown" });
    assert.equal(!unknownSource.ok && unknownSource.error.code, "invalid_input");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
