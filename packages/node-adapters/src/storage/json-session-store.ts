import { JsonFileDocument } from "./json-file.js";
import type { SessionStore } from "@rack/core/sessions/ports";
import { summarizeSession, type SessionId, type SessionRecord } from "@rack/core/sessions/types";

interface SessionDocument {
  readonly schemaVersion: 4;
  readonly sessions: SessionRecord[];
}

type LegacySession = Omit<SessionRecord, "projectId"> & { projectId?: string; workspaceId?: string };

/** Durable sessions; schema 4 admits standalone chats and retains project migrations. */
export class JsonSessionStore implements SessionStore {
  private readonly document: JsonFileDocument<SessionDocument>;

  constructor(filePath: string, resolveProjectId: (id: string) => Promise<string> = async (id) => id) {
    this.document = new JsonFileDocument<SessionDocument>(filePath, {
      schemaVersion: 4,
      sessions: [],
    }, async (stored) => {
      const current = stored as SessionDocument;
      const version = (stored as { schemaVersion: number }).schemaVersion;
      if (version === 4) return current;
      if (version === 3) return { ...current, schemaVersion: 4 };
      if (version !== 1 && version !== 2) {
        throw new Error("Unsupported sessions schema version.");
      }
      return {
        schemaVersion: 4,
        // Both older formats identify the actual folder with workspaceId.
        // It takes precedence over the obsolete parent projectId. Native
        // continuations and messages stay untouched for provider resume.
        sessions: await Promise.all(current.sessions.map(async (session) => {
          const { workspaceId, ...rest } = session as LegacySession;
          const projectId = workspaceId ?? rest.projectId;
          if (projectId === undefined || projectId.trim() === "") {
            throw new Error(`Session '${session.id}' has no saved project folder reference.`);
          }
          return { ...rest, projectId: await resolveProjectId(projectId) };
        })),
      };
    });
  }

  listSummaries() { return this.document.select((value) => value.sessions.map(summarizeSession)); }

  async list(): Promise<readonly SessionRecord[]> {
    return (await this.document.read()).sessions;
  }

  async get(sessionId: SessionId): Promise<SessionRecord | undefined> {
    return this.document.select((value) => value.sessions.find((session) => session.id === sessionId));
  }

  async save(session: SessionRecord): Promise<void> {
    await this.document.update((current) => ({
      ...current,
      sessions: [
        ...current.sessions.filter((candidate) => candidate.id !== session.id),
        session,
      ],
    }));
  }

  async remove(sessionId: SessionId): Promise<void> {
    await this.document.update((current) => ({
      ...current,
      sessions: current.sessions.filter((session) => session.id !== sessionId),
    }));
  }
}
