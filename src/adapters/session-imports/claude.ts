import { sameImportProject } from "../../core/session-imports/project-path.js";
import { getSessionInfo, getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk";
import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";

import type { LocalSessionSource } from "../../core/session-imports/ports.js";
import type { ExternalSession, ExternalSessionSnapshot, ImportedMessage } from "../../core/session-imports/types.js";
import { isoDate, record, visibleContent } from "./content.js";

/** Reads the user's local Claude transcripts through SDK history helpers, without a query/model turn. */
export class ClaudeLocalSessionSource implements LocalSessionSource {
  readonly sourceId = "local-claude";
  readonly providerName = "Claude";

  constructor(private readonly api: {
    readonly listSessions: typeof listSessions;
    readonly getSessionInfo: typeof getSessionInfo;
    readonly getSessionMessages: typeof getSessionMessages;
  } = { listSessions, getSessionInfo, getSessionMessages }) {}

  async list(projectPath: string): Promise<readonly ExternalSession[]> {
    // Windows encoded transcript directories may retain the original cwd's
    // casing. Enumerate SDK history, then enforce exact folder identity locally.
    const sessions = await this.api.listSessions({ ...(process.platform === "win32" ? {} : { dir: projectPath }), includeWorktrees: false });
    return sessions.filter((session) => session.cwd !== undefined && sameImportProject(session.cwd, projectPath))
      .map((session) => this.describe(session));
  }

  async read(projectPath: string, nativeSessionId: string): Promise<ExternalSessionSnapshot> {
    const info = await this.api.getSessionInfo(nativeSessionId, process.platform === "win32" ? {} : { dir: projectPath });
    if (info?.cwd === undefined || !sameImportProject(info.cwd, projectPath)) {
      throw new Error("Claude session is not in the selected project.");
    }
    const messages = await this.api.getSessionMessages(nativeSessionId, { dir: info.cwd });
    const imported: ImportedMessage[] = [];
    const calls = new Map<string, { index: number; value: Record<string, unknown> }>();
    for (const item of messages) {
      const body = record(item.message);
      if (typeof body.content === "string") {
        imported.push({ role: item.type, content: body.content, nativeMessageId: item.uuid });
        continue;
      }
      for (const [index, raw] of (Array.isArray(body.content) ? body.content : []).entries()) {
        const block = record(raw);
        if (block.type === "thinking" && typeof block.thinking === "string") {
          imported.push({ role: "system", content: block.thinking, nativeMessageId: `${item.uuid}:${index}`,
            presentation: "thinking", thinkingFormat: "trace" });
        } else if (block.type === "tool_use") {
          const value = { type: block.name ?? "Tool call", input: block.input, status: "inProgress" };
          const position = imported.length;
          imported.push({ role: "tool", content: JSON.stringify(value, null, 2), nativeMessageId: item.uuid });
          if (typeof block.id === "string") calls.set(block.id, { index: position, value });
        } else if (block.type === "tool_result") {
          const output = visibleContent(block.content) || JSON.stringify(block.content ?? null);
          const call = typeof block.tool_use_id === "string" ? calls.get(block.tool_use_id) : undefined;
          if (call !== undefined) {
            const value = { ...call.value, output, status: block.is_error === true ? "failed" : "completed", is_error: block.is_error === true };
            imported[call.index] = { ...imported[call.index]!, content: JSON.stringify(value, null, 2) };
          } else imported.push({ role: "tool", content: output, nativeMessageId: item.uuid });
        } else {
          const content = visibleContent([block]);
          if (content.trim() !== "") {
            const previous = imported.at(-1);
            if (previous?.role === item.type && previous.nativeMessageId === item.uuid) {
              imported[imported.length - 1] = { ...previous, content: `${previous.content}\n\n${content}` };
            } else imported.push({ role: item.type, content, nativeMessageId: item.uuid });
          }
        }
      }
    }
    return { session: this.describe(info), messages: imported };
  }

  private describe(info: SDKSessionInfo): ExternalSession {
    const createdAt = isoDate(info.createdAt ?? info.lastModified);
    return { sourceId: this.sourceId, providerName: this.providerName, nativeSessionId: info.sessionId,
      projectPath: info.cwd ?? "", title: (info.customTitle || info.summary || "Claude session").slice(0, 256),
      createdAt, updatedAt: isoDate(info.lastModified, createdAt) };
  }
}
