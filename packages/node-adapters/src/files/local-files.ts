import { constants } from "node:fs";
import { chmod, lstat, open, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { FileOperationError, type FileDocument, type FileListing, type ProjectFiles } from "@rack/features/files";

const MAX_BYTES = 1024 * 1024;
const versionOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Bounded, project-scoped file access. Symlinks remain visible but are never
 * followed. Saves compare content versions and atomically replace the file,
 * so an editor cannot silently overwrite a provider's intervening edit.
 */
export class LocalProjectFiles implements ProjectFiles {
  async list(root: string, path: string): Promise<FileListing> {
    const target = await this.target(root, path);
    const entries = await readdir(target, { withFileTypes: true });
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    return { path, truncated: entries.length > 1000, entries: entries.slice(0, 1000).map((entry) => ({
      name: entry.name, path: path === "" ? entry.name : `${path}/${entry.name}`,
      kind: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
    })) };
  }

  async read(root: string, path: string): Promise<FileDocument> {
    const target = await this.target(root, path);
    // Check before opening: opening a FIFO for reading would otherwise park
    // the execution host indefinitely. NONBLOCK also closes the replacement
    // race between this check and open; fstat below checks the opened object.
    if (!(await lstat(target)).isFile()) throw new FileOperationError("invalid_input", "Choose a regular file.");
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new FileOperationError("invalid_input", "Choose a regular file.");
      if (stat.size > MAX_BYTES) return { path, text: "", version: "", editable: false, notice: "This file is larger than the 1 MiB editor limit. Open it externally." };
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const chunk = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
      const content = bytes.subarray(0, bytesRead);
      if (bytesRead > MAX_BYTES) return { path, text: "", version: "", editable: false, notice: "This file grew beyond the editor limit. Open it externally." };
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content); }
      catch { return { path, text: "", version: versionOf(content), editable: false, notice: "Binary or non-UTF-8 file. Open it externally." }; }
      if (content.includes(0)) return { path, text: "", version: versionOf(content), editable: false, notice: "Binary file. Open it externally." };
      return { path, text, version: versionOf(content), editable: true };
    } finally { await handle.close(); }
  }

  async save(root: string, path: string, text: string, version: string): Promise<FileDocument> {
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new FileOperationError("invalid_input", "Files must fit within the 1 MiB editor limit.");
    const target = await this.target(root, path);
    const current = await this.read(root, path);
    if (!current.editable) throw new FileOperationError("invalid_input", "This file cannot be edited here.");
    if (current.version !== version) throw new FileOperationError("file_conflict", "This file changed on disk. Reload it before saving; your draft is kept.");
    const stat = await lstat(target);
    const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.rack-tmp`);
    try {
      await writeFile(temporary, text, { flag: "wx", mode: stat.mode & 0o777 });
      // writeFile's mode is filtered by umask. Restore executable and other
      // ordinary permission bits before the atomic replacement.
      await chmod(temporary, stat.mode & 0o777);
      // Recheck after preparing the replacement, narrowing the race with
      // external editors. Filesystem writes cannot be a cross-process CAS.
      if ((await this.read(root, path)).version !== version) throw new FileOperationError("file_conflict", "This file changed on disk. Reload before saving; your draft is kept.");
      await this.target(root, path);
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(() => {}); }
    return { path, text, version: versionOf(Buffer.from(text)), editable: true };
  }

  private async target(root: string, path: string): Promise<string> {
    const canonical = await realpath(root);
    if (isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).includes("..")) throw new FileOperationError("invalid_input", "Choose a path inside the project.");
    let target = canonical;
    for (const part of path.split(/[\\/]/).filter(Boolean)) {
      target = join(target, part);
      if ((await lstat(target)).isSymbolicLink()) throw new FileOperationError("invalid_input", "Symbolic links cannot be opened in the project editor.");
    }
    const actual = await realpath(target);
    const rel = relative(canonical, actual);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || resolve(actual) !== resolve(target)) throw new FileOperationError("invalid_input", "Choose a path inside the project.");
    return actual;
  }
}
