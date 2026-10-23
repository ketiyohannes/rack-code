import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemorySessionStore } from "@rack/core/sessions/in-memory-store";
import { SessionsService } from "@rack/core/sessions/service";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "@rack/core/sessions/attachments";
import { validateCommandParams } from "@rack/contracts/commands";
import { DirectoryAttachmentStore } from "./directory-attachment-store.js";

test("attachment copies preserve names and binary bytes after source removal and storage reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rack-attachments-"));
  try {
    const store = new DirectoryAttachmentStore(join(directory, "attachments"));
    // A filename matching the manifest must still be attachable, alongside
    // binary/image/document formats and an extensionless empty file.
    for (const name of ["sample.png", "sample.pdf", "manifest.json", "notes\nquoted.txt", "LICENSE"]) {
      const source = join(directory, name);
      const bytes = name === "LICENSE" ? Buffer.alloc(0) : Buffer.from([0, 255, 42, 13, 10]);
      await writeFile(source, bytes);
      const attachment = await store.importFile("session", source);
      await rm(source);
      const restored = await new DirectoryAttachmentStore(join(directory, "attachments")).get("session", attachment.id);
      assert.equal(restored.name, name);
      assert.equal(restored.size, bytes.length);
      assert.deepEqual(await readFile(restored.path), bytes);
      await assert.rejects(store.get("another-session", attachment.id));
      await rm(restored.path);
      await assert.rejects(store.get("session", attachment.id));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("imports reject folders, relative paths, oversized files and invalid IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rack-attachments-"));
  try {
    const store = new DirectoryAttachmentStore(join(directory, "attachments"));
    await assert.rejects(store.importFile("session", directory), /regular files/);
    await assert.rejects(store.importFile("session", "relative.txt"), /absolute/);
    await assert.rejects(store.get("session", "../escape"), /Invalid attachment ID/);
    const large = join(directory, "large.bin");
    await writeFile(large, "");
    await truncate(large, MAX_ATTACHMENT_BYTES + 1);
    await assert.rejects(store.importFile("session", large), /50 MB/);
    await assert.rejects(stat(join(directory, "attachments")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Sessions rolls back failed batches and checks ownership/count before execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rack-attachments-"));
  try {
    const store = new DirectoryAttachmentStore(join(directory, "attachments"));
    const sessions = new SessionsService(new InMemorySessionStore(), { attachments: store });
    await sessions.create({ id: "session", projectId: "project" });
    const source = join(directory, "notes.txt");
    await writeFile(source, "contents");
    await assert.rejects(sessions.attachFiles("unknown-session", [source]));
    await assert.rejects(sessions.attachFiles("session", [source, join(directory, "missing.txt")]));
    const roots = await readdir(join(directory, "attachments"));
    assert.equal(roots.length, 1);
    assert.deepEqual(await readdir(join(directory, "attachments", roots[0]!)), []);
    const [attachment] = await sessions.attachFiles("session", [source]);
    assert.ok(attachment);
    assert.deepEqual(await sessions.resolveAttachments("session", [attachment.id]), [attachment]);
    await assert.rejects(sessions.resolveAttachments("session", [attachment.id, attachment.id]), /duplicate/);
    await assert.rejects(sessions.attachFiles("session", []), /Choose between/);
    await assert.rejects(sessions.attachFiles("session", Array(MAX_ATTACHMENTS + 1).fill(source)), /Choose between/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop attachment payloads are bounded and reject untrusted paths on runs", () => {
  assert.throws(() => validateCommandParams("sessions.attachFiles", { sessionId: "session", paths: Array(21).fill("/file") }));
  assert.throws(() => validateCommandParams("sessions.attachFiles", { sessionId: "session", paths: [3] }));
  assert.throws(() => validateCommandParams("runs.start", { sessionId: "session", projectId: "project", providerId: "fake",
    runtimeId: "fake", prompt: "test", permissionMode: "ask", attachments: [{ path: "/arbitrary" }] }));
});
