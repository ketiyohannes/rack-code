/**
 * Stores durable attachment copies and small manifests outside the project.
 * Hashing session IDs and generating file IDs prevents names from escaping
 * their directory. Reading a manifest never trusts a serialized file path.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { MAX_ATTACHMENT_BYTES, type AttachmentStore, type SessionAttachment } from "@rack/core/sessions/attachments";

export class DirectoryAttachmentStore implements AttachmentStore {
  constructor(private readonly directory: string) {}

  async importFile(sessionId: string, sourcePath: string): Promise<SessionAttachment> {
    if (!isAbsolute(sourcePath)) throw new Error("Choose an absolute file path.");
    const source = await stat(sourcePath);
    if (!source.isFile()) throw new Error("Only regular files can be attached.");
    if (source.size > MAX_ATTACHMENT_BYTES) throw new Error(`${basename(sourcePath)} exceeds the 50 MB attachment limit.`);
    const id = randomUUID();
    const directory = this.fileDirectory(sessionId, id);
    const name = basename(sourcePath);
    const path = join(directory, "file", name);
    await mkdir(join(directory, "file"), { recursive: true, mode: 0o700 });
    try {
      await copyFile(sourcePath, path, constants.COPYFILE_EXCL);
      const copied = await stat(path);
      // Recheck the copy because the source could grow while being copied.
      if (copied.size > MAX_ATTACHMENT_BYTES) throw new Error(`${name} exceeds the 50 MB attachment limit.`);
      const attachment: SessionAttachment = { id, name, path, size: copied.size };
      await writeFile(join(directory, "manifest.json"), JSON.stringify(attachment), { flag: "wx", mode: 0o600 });
      return attachment;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async get(sessionId: string, attachmentId: string): Promise<SessionAttachment> {
    const directory = this.fileDirectory(sessionId, attachmentId);
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as SessionAttachment;
    if (typeof manifest.name !== "string" || basename(manifest.name) !== manifest.name || [".", ".."].includes(manifest.name)) {
      throw new Error("Invalid attachment manifest.");
    }
    const path = join(directory, "file", manifest.name);
    const file = await stat(path);
    if (!file.isFile() || file.size > MAX_ATTACHMENT_BYTES) throw new Error("The attached file is unavailable or too large.");
    return { id: attachmentId, name: manifest.name, path, size: file.size };
  }

  async remove(sessionId: string, attachmentId: string): Promise<void> {
    await rm(this.fileDirectory(sessionId, attachmentId), { recursive: true, force: true });
  }

  private fileDirectory(sessionId: string, id: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid attachment ID.");
    return join(this.directory, createHash("sha256").update(sessionId).digest("hex"), id);
  }
}
