import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryProjectStore, ProjectsService } from "../projects/index.js";
import { InMemorySessionStore, SessionsService } from "../sessions/index.js";
import { SessionImportsService } from "./service.js";
import type { LocalSessionSource } from "./ports.js";

const date = "2026-10-14T00:00:00.000Z";
function source(path: string): LocalSessionSource {
  const session = { sourceId: "fake", providerName: "Fake", nativeSessionId: "native-1", projectPath: path,
    title: "Imported task", createdAt: date, updatedAt: date };
  return { sourceId: "fake", providerName: "Fake", list: async () => [session],
    read: async () => ({ session, messages: [
      { role: "user", content: "Build the feature", nativeMessageId: "user-1" },
      { role: "tool", content: "Already wrote file.ts" },
      { role: "assistant", content: "The feature is ready", nativeMessageId: "reply-1" },
    ] }) };
}
async function setup(sources?: readonly LocalSessionSource[]) {
  const projects = new ProjectsService(new InMemoryProjectStore());
  const project = await projects.createProject({ path: "/tmp/project" });
  const sessions = new SessionsService(new InMemorySessionStore());
  const imports = new SessionImportsService(projects, sessions, sources ?? [source(project.path)]);
  return { project, projects, sessions, imports };
}

test("imports a complete snapshot once across concurrent requests and marks provenance", async () => {
  const { project, sessions, imports } = await setup();
  const before = await imports.discover(project.id);
  assert.equal(before.sessions[0]?.importedSessionId, undefined);
  const results = await Promise.all([
    imports.import(project.id, "fake", "native-1"), imports.import(project.id, "fake", "native-1"),
  ]);
  assert.equal(results[0]?.session.id, results[1]?.session.id);
  assert.equal(results[0]?.alreadyImported, false);
  assert.equal(results[1]?.alreadyImported, true);
  const [session] = await sessions.list(project.id);
  assert.ok(session);
  assert.equal(session.projectId, project.id);
  assert.equal(session.title, "Imported task");
  assert.deepEqual(session.messages.map((message) => message.role), ["user", "tool", "assistant"]);
  assert.equal(session.messages[2]?.content, "The feature is ready");
  assert.equal(session.messages[2]?.metadata?.["nativeMessageId"], "reply-1");
  assert.deepEqual(session.continuations, []);
  assert.equal(session.importSource?.nativeSessionId, "native-1");
  assert.equal((await imports.discover(project.id)).sessions[0]?.importedSessionId, session.id);
});

test("discovery excludes other folders and retains successes when a provider fails", async () => {
  const broken = { ...source("/tmp/project"), sourceId: "broken", providerName: "Broken", list: async () => { throw new Error("private diagnostic"); } };
  const { project, imports } = await setup([source("/tmp/project"), broken,
    { ...source("/tmp/other"), sourceId: "other" }]);
  const result = await imports.discover(project.id);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.failures[0]?.sourceId, "broken");
  assert.doesNotMatch(result.failures[0]?.message ?? "", /private diagnostic/);
});

test("revalidates folder and native identity at preview/import and saves no partial record", async () => {
  const { project, sessions, imports } = await setup([source("/tmp/other")]);
  await assert.rejects(imports.preview(project.id, "fake", "native-1"), /does not belong/);
  await assert.rejects(imports.import(project.id, "fake", "native-1"), /does not belong/);
  await assert.rejects(imports.import(project.id, "missing", "native-1"), /Unknown/);
  assert.deepEqual(await sessions.list(project.id), []);
});
