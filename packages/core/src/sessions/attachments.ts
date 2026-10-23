/**
 * Session-owned file descriptors and the storage port. Files stay local;
 * runtimes receive quoted paths and use their own file-reading tools under
 * the chosen permission mode. No provider upload protocol belongs here.
 */
export interface SessionAttachment {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly size: number;
}

export const MAX_ATTACHMENTS = 20;
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export interface AttachmentStore {
  /** Copies a regular file into durable storage scoped to this session. */
  importFile(sessionId: string, sourcePath: string): Promise<SessionAttachment>;
  /** Resolves only a previously imported file belonging to this session. */
  get(sessionId: string, attachmentId: string): Promise<SessionAttachment>;
  /** Rolls back a newly imported copy after a failed batch. */
  remove(sessionId: string, attachmentId: string): Promise<void>;
}

/** Keep file references in saved conversation context as well as runtime input. */
export function promptWithAttachments(prompt: string, attachments: readonly SessionAttachment[]): string {
  if (attachments.length === 0) return prompt;
  return `${prompt || "Please examine the attached files."}\n\nAttached local files (use your file-reading tools to inspect the relevant contents):\n${attachments.map((file) =>
    `- ${JSON.stringify(file.name)}: ${JSON.stringify(file.path)}`).join("\n")}`;
}
