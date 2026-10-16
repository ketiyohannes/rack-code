import { sameImportProject } from "../../core/session-imports/project-path.js";
import { resolveCodexCommand } from "../runtimes/codex-command.js";

import type { LocalSessionSource } from "../../core/session-imports/ports.js";
import type { ExternalSession, ExternalSessionSnapshot, ImportedMessage } from "../../core/session-imports/types.js";
import { JsonRpcProcess } from "../runtimes/json-rpc-process.js";
import { isoDate, record, visibleContent } from "./content.js";

type HistoryProcess = Pick<JsonRpcProcess, "request" | "notify" | "close">;

/**
 * Reads local Codex CLI/app history through app-server's supported APIs.
 * Uses the user's normal local Codex store, not Rack's private account store.
 * Only initialize/list/read commands are sent: no model turns, resume, forks,
 * tools, authentication changes, or transcript mutations occur during import.
 */
export class CodexLocalSessionSource implements LocalSessionSource {
  readonly sourceId = "local-codex";
  readonly providerName = "Codex";

  constructor(private readonly options: {
    readonly createProcess?: (projectPath: string) => HistoryProcess;
    readonly timeoutMs?: number;
    /** Alternate local store for embedding/tests; never supplied by renderer commands. */
    readonly codexHome?: string;
  } = {}) {}

  list(projectPath: string): Promise<readonly ExternalSession[]> {
    return this.withProcess(projectPath, async (process) => {
      const sessions = new Map<string, ExternalSession>();
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = record(await process.request("thread/list", {
          // Server cwd filtering can compare raw strings. Windows paths must
          // instead be matched locally to tolerate casing and slash differences.
          ...(globalThis.process.platform === "win32" ? {} : { cwd: projectPath }),
          limit: 100, sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
          useStateDbOnly: false,
          ...(cursor === undefined ? {} : { cursor }),
        }));
        for (const raw of Array.isArray(page.data) ? page.data : []) {
          const thread = record(raw);
          if (typeof thread.cwd !== "string" || !sameImportProject(thread.cwd, projectPath)) continue;
          if (record(thread.status).type === "active") continue;
          if (typeof thread.id !== "string") continue;
          sessions.set(thread.id, this.describe(thread));
        }
        cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
        if (cursor !== undefined && seen.has(cursor)) throw new Error("Codex returned a repeated history cursor.");
        if (cursor !== undefined) seen.add(cursor);
      } while (cursor !== undefined);
      return [...sessions.values()];
    });
  }

  read(projectPath: string, nativeSessionId: string): Promise<ExternalSessionSnapshot> {
    return this.withProcess(projectPath, async (process) => {
      const response = record(await process.request("thread/read", { threadId: nativeSessionId, includeTurns: true }));
      const thread = record(response.thread);
      if (thread.id !== nativeSessionId || typeof thread.cwd !== "string" || !sameImportProject(thread.cwd, projectPath)) {
        throw new Error("Codex session is not in the selected project.");
      }
      if (record(thread.status).type === "active") throw new Error("Wait for this Codex session to finish before importing.");
      let turns = Array.isArray(thread.turns) ? thread.turns : [];
      // New paginated stores may omit turns from thread/read. Page the public
      // history API when needed; older stores already supply full turns.
      if (turns.length === 0) {
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const page = record(await process.request("thread/turns/list", {
            threadId: nativeSessionId, limit: 100, sortDirection: "asc", itemsView: "full",
            ...(cursor === undefined ? {} : { cursor }),
          }));
          turns = [...turns, ...(Array.isArray(page.data) ? page.data : [])];
          cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
          if (cursor !== undefined && seen.has(cursor)) throw new Error("Codex returned a repeated turn cursor.");
          if (cursor !== undefined) seen.add(cursor);
        } while (cursor !== undefined);
      }
      const messages: ImportedMessage[] = [];
      for (const raw of turns) {
        const turn = record(raw);
        for (const item of Array.isArray(turn.items) ? turn.items : []) {
          const value = record(item);
          if (value.type === "reasoning") {
            for (const [field, format] of [["content", "trace"], ["summary", "summary"]] as const) {
              for (const part of Array.isArray(value[field]) ? value[field] as unknown[] : []) {
                if (typeof part === "string" && part.trim() !== "") messages.push({ role: "system", content: part,
                  presentation: "thinking", thinkingFormat: format,
                  ...(typeof value.id === "string" ? { nativeMessageId: value.id } : {}) });
              }
            }
            continue;
          }
          const content = value.type === "userMessage" ? visibleContent(value.content)
            : value.type === "agentMessage" && typeof value.text === "string" ? value.text
            : ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "imageView"].includes(String(value.type))
              ? JSON.stringify(value, null, 2) : "";
          if (content === "") continue;
          messages.push({
            role: value.type === "userMessage" ? "user" : value.type === "agentMessage" ? "assistant" : "tool",
            content, ...(typeof value.id === "string" ? { nativeMessageId: value.id } : {}),
          });
        }
      }
      return { session: this.describe(thread), messages };
    });
  }

  private describe(thread: Record<string, unknown>): ExternalSession {
    // Codex exposes thread timestamps in epoch seconds, unlike Claude's ms.
    const createdAt = isoDate(typeof thread.createdAt === "number" ? thread.createdAt * 1000 : thread.createdAt);
    return {
      sourceId: this.sourceId, providerName: this.providerName,
      nativeSessionId: String(thread.id), projectPath: String(thread.cwd),
      title: String(thread.name || thread.preview || "Codex session").slice(0, 256),
      createdAt, updatedAt: isoDate(typeof thread.updatedAt === "number" ? thread.updatedAt * 1000 : thread.updatedAt, createdAt),
    };
  }

  private async withProcess<T>(projectPath: string, operation: (process: HistoryProcess) => Promise<T>): Promise<T> {
    const process = this.options.createProcess?.(projectPath) ?? JsonRpcProcess.start(resolveCodexCommand(), ["app-server", "--stdio"], {
      cwd: projectPath, environment: { ...globalThis.process.env,
        ...(this.options.codexHome === undefined ? {} : { CODEX_HOME: this.options.codexHome }) },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Codex history read timed out.")), this.options.timeoutMs ?? 30_000);
    });
    try {
      return await Promise.race([(async () => {
        await process.request("initialize", { clientInfo: { name: "rack-history", title: "Rack session import", version: "1.0.0" }, capabilities: {} });
        process.notify("initialized", {});
        return operation(process);
      })(), timeout]);
    } finally {
      clearTimeout(timer);
      await process.close();
    }
  }
}
