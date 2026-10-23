import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonProjectStore } from "./json-project-store.js";
import { JsonSessionStore } from "./json-session-store.js";
import { JsonExecutionStore } from "./json-execution-store.js";

const timestamp = "2026-10-14T00:00:00.000Z";
const folder = (id: string, path = `/folders/${id}`) => ({
  id, path, kind: "shared", startingRevision: "revision-1", createdAt: timestamp, updatedAt: timestamp,
});
const root = { id: "old-parent", name: "Demo", rootPath: "/folders/folder-1", createdAt: timestamp, updatedAt: timestamp };

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value));
}

for (const format of ["workspace-only", "project-and-workspace", "partial-workspace-import"] as const) {
  test(`migrates ${format} folders, session continuations and run history together`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "rack-project-migration-"));
    try {
      const projectPath = join(directory, "projects.json");
      const workspacePath = join(directory, "workspaces.json");
      const oldFolder = { ...folder("folder-1"), projectId: root.id, activeWriterAttemptId: "attempt-1" };
      if (format !== "workspace-only") {
        await writeJson(projectPath, {
          schemaVersion: 1, projects: [root],
          workspaces: [oldFolder, { ...folder("folder-2"), projectId: root.id }],
        });
      }
      if (format !== "project-and-workspace") {
        await writeJson(workspacePath, {
          schemaVersion: 2,
          workspaces: [{ ...folder("folder-1"), activeWriterAttemptId: "attempt-1", startingRevision: "newer-revision" }],
        });
      }
      const legacySession = {
        id: "session-1", workspaceId: "folder-1",
        ...(format === "workspace-only" ? {} : { projectId: root.id }),
        title: "Saved session", messages: [{ id: "m1", role: "assistant", content: "Saved reply", createdAt: timestamp }],
        continuations: [{ runtimeId: "codex-app-server", nativeSessionId: "native-1", seenThroughMessageId: "m1" }],
        createdAt: timestamp, updatedAt: timestamp,
      };
      await writeJson(join(directory, "sessions.json"), { schemaVersion: 1, sessions: [legacySession] });
      const legacyRun = {
        id: "run-1", sessionId: "session-1", workspaceId: "folder-1", prompt: "Saved task", providerId: "codex",
        accountId: "account-1", permissionMode: "ask", status: "unknown", attemptIds: ["attempt-1"], createdAt: timestamp, updatedAt: timestamp,
      };
      const attempts = [{ id: "attempt-1", runId: "run-1", runtimeId: "codex-app-server", providerId: "codex", accountId: "account-1", status: "unknown", nativeSessionId: "native-1", createdAt: timestamp, updatedAt: timestamp }];
      const journal = [{ sequence: 1, runId: "run-1", attemptId: "attempt-1", type: "tool_result", payload: { output: "Already executed" }, observedAt: timestamp }];
      await writeJson(join(directory, "execution.json"), { schemaVersion: 1, runs: [legacyRun], attempts, journal });

      const projects = new JsonProjectStore(projectPath, workspacePath);
      const sessions = new JsonSessionStore(join(directory, "sessions.json"));
      const execution = new JsonExecutionStore(join(directory, "execution.json"));
      // Parallel read/save is how startup and commands encounter migration.
      const [, , session, run] = await Promise.all([
        projects.listProjects(), projects.saveProject({ id: "new-project", path: "/new", createdAt: timestamp, updatedAt: timestamp }),
        sessions.get("session-1"), execution.getRun("run-1"),
      ]);
      assert.ok(session);
      assert.ok(run);
      assert.equal(session.projectId, "folder-1");
      assert.equal(run.projectId, session.projectId);
      assert.deepEqual(session.messages, legacySession.messages);
      assert.deepEqual(session.continuations, legacySession.continuations);
      assert.equal(run.status, "unknown");
      assert.deepEqual(await execution.getAttempt("attempt-1"), attempts[0]);
      assert.deepEqual(await execution.listJournal("run-1"), journal);
      assert.equal("workspaceId" in session, false);
      assert.equal("workspaceId" in run, false);

      const reloaded = new JsonProjectStore(projectPath, workspacePath);
      const migratedFolder = await reloaded.getProject(session.projectId);
      assert.equal(migratedFolder?.path, "/folders/folder-1");
      assert.equal(migratedFolder?.activeWriterAttemptId, "attempt-1");
      assert.equal(migratedFolder?.startingRevision, format === "project-and-workspace" ? "revision-1" : "newer-revision");
      assert.equal(migratedFolder && "kind" in migratedFolder, false);
      assert.equal(migratedFolder && "projectId" in migratedFolder, false);
      assert.deepEqual((await reloaded.listProjects()).map((project) => project.id).sort(),
        format === "workspace-only" ? ["folder-1", "new-project"] : ["folder-1", "folder-2", "new-project"]);
      assert.equal(JSON.parse(await readFile(projectPath, "utf8")).schemaVersion, 4);
      assert.equal(JSON.parse(await readFile(join(directory, "sessions.json"), "utf8")).schemaVersion, 4);
      assert.equal(JSON.parse(await readFile(join(directory, "execution.json"), "utf8")).schemaVersion, 4);
      assert.equal((await new JsonSessionStore(join(directory, "sessions.json")).get("session-1"))?.projectId, "folder-1");
      assert.equal((await new JsonExecutionStore(join(directory, "execution.json")).getRun("run-1"))?.projectId, "folder-1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("retains a legacy project with no workspace and does not re-import an authoritative empty document", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rack-project-roots-"));
  try {
    const path = join(directory, "projects.json");
    await writeJson(path, { schemaVersion: 1, projects: [root], workspaces: [] });
    const store = new JsonProjectStore(path);
    assert.deepEqual(await store.listProjects(), [{ id: root.id, path: root.rootPath, createdAt: timestamp, updatedAt: timestamp }]);
    await writeJson(path, { schemaVersion: 3, projects: [] });
    await writeJson(join(directory, "workspaces.json"), { schemaVersion: 2, workspaces: [folder("old-folder")] });
    assert.deepEqual(await new JsonProjectStore(path).listProjects(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration exposes corrupt legacy data without overwriting it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rack-project-corrupt-"));
  try {
    const path = join(directory, "projects.json");
    const legacyPath = join(directory, "workspaces.json");
    await writeFile(legacyPath, "corrupt legacy data");
    await assert.rejects(new JsonProjectStore(path, legacyPath).listProjects(), SyntaxError);
    await assert.rejects(readFile(path), { code: "ENOENT" });
    assert.equal(await readFile(legacyPath, "utf8"), "corrupt legacy data");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const version of [1, 3] as const) {
  test(`consolidates duplicate folder IDs from schema ${version} with both histories preserved`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "rack-project-duplicates-"));
    try {
      const projectPath = join(directory, "projects.json");
      const original = { ...folder("old-id"), path: "/tmp/demo", createdAt: "2026-10-12T00:00:00.000Z" };
      const duplicate = { ...folder("duplicate-id"), path: "/tmp/demo/", activeWriterAttemptId: "writer-1" };
      await writeJson(projectPath, version === 1
        ? { schemaVersion: 1, projects: [], workspaces: [original, duplicate] }
        : { schemaVersion: 3, projects: [original, duplicate] });
      const projects = new JsonProjectStore(projectPath);
      const resolveId = async (id: string) => {
        const project = await projects.getProject(id);
        assert.ok(project);
        return project.id;
      };
      const sessionRecords = [original, duplicate].map((project, index) => ({
        id: `session-${index}`, projectId: project.id, messages: [{ id: `message-${index}`, role: "assistant", content: `History ${index}`, createdAt: timestamp }],
        continuations: [{ runtimeId: "codex", nativeSessionId: `native-${index}` }], createdAt: timestamp, updatedAt: timestamp,
      }));
      const runs = sessionRecords.map((session, index) => ({
        id: `run-${index}`, sessionId: session.id, projectId: session.projectId, prompt: "saved", providerId: "codex", accountId: "account",
        permissionMode: "ask", status: "completed", attemptIds: [], createdAt: timestamp, updatedAt: timestamp,
      }));
      await writeJson(join(directory, "sessions.json"), { schemaVersion: 2, sessions: sessionRecords });
      await writeJson(join(directory, "execution.json"), { schemaVersion: 2, runs, attempts: [], journal: [] });
      const sessions = new JsonSessionStore(join(directory, "sessions.json"), resolveId);
      const execution = new JsonExecutionStore(join(directory, "execution.json"), resolveId);
      const migratedSessions = await sessions.list();
      assert.equal((await projects.listProjects()).length, 1);
      assert.equal((await projects.getProject("duplicate-id"))?.id, "old-id");
      assert.equal((await projects.getProject("old-id"))?.activeWriterAttemptId, "writer-1");
      assert.deepEqual(migratedSessions.map((session) => session.projectId), ["old-id", "old-id"]);
      assert.deepEqual(migratedSessions.map((session) => session.messages), sessionRecords.map((session) => session.messages));
      assert.deepEqual(migratedSessions.map((session) => session.continuations), sessionRecords.map((session) => session.continuations));
      assert.equal((await execution.getRun("run-0"))?.projectId, "old-id");
      assert.equal((await execution.getRun("run-1"))?.projectId, "old-id");
      assert.equal((await new JsonProjectStore(projectPath).getProject("duplicate-id"))?.id, "old-id");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("duplicate folders with conflicting active writers are not silently merged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rack-project-writers-"));
  try {
    const path = join(directory, "projects.json");
    const input = { schemaVersion: 3, projects: [
      { ...folder("one", "/tmp/demo"), activeWriterAttemptId: "writer-one" },
      { ...folder("two", "/tmp/demo"), activeWriterAttemptId: "writer-two" },
    ] };
    await writeJson(path, input);
    await assert.rejects(new JsonProjectStore(path).listProjects(), /two editing attempts/);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), input);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
