/** Project file browsing/editing uses the same working files as native runtime
 * tools. The host resolves project identity; adapters own platform I/O.
 */
export interface FileEntry { readonly name: string; readonly path: string; readonly kind: "directory" | "file" | "symlink" | "other" }
export interface FileListing { readonly path: string; readonly entries: readonly FileEntry[]; readonly truncated: boolean }
export interface FileDocument { readonly path: string; readonly text: string; readonly version: string; readonly editable: boolean; readonly notice?: string }
export interface ProjectFiles {
  list(root: string, path: string): Promise<FileListing>;
  read(root: string, path: string): Promise<FileDocument>;
  save(root: string, path: string, text: string, version: string): Promise<FileDocument>;
}
export class FileOperationError extends Error {
  constructor(readonly code: "invalid_input" | "file_conflict", message: string) { super(message); this.name = "FileOperationError"; }
}
export class FilesService {
  private readonly saves = new Map<string, Promise<FileDocument>>();
  constructor(private readonly project: (id: string) => Promise<{ path: string }>, private readonly files: ProjectFiles, private readonly session?: (id: string) => Promise<{ path: string }>) {}
  /** Session scope resolves a private chat folder or its attached project. */
  forSession(): FilesService {
    if (!this.session) throw new FileOperationError("invalid_input", "Session files are unavailable.");
    return new FilesService(this.session, this.files);
  }
  async list(projectId: string, path = ""): Promise<FileListing> { return this.files.list((await this.project(projectId)).path, path); }
  async read(projectId: string, path: string): Promise<FileDocument> { return this.files.read((await this.project(projectId)).path, path); }
  async save(projectId: string, path: string, text: string, version: string): Promise<FileDocument> {
    const root = (await this.project(projectId)).path;
    // Equivalent lexical paths must share one save lane. The adapter still
    // rejects traversal and symlinks before accessing any file.
    const normalized = path.split(/[\\/]/).filter((part) => part !== "" && part !== ".").join("/");
    const key = `${root}\0${normalized}`;
    const previous = this.saves.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.files.save(root, path, text, version));
    this.saves.set(key, pending);
    try { return await pending; } finally { if (this.saves.get(key) === pending) this.saves.delete(key); }
  }
}
