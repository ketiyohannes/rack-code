import type { SessionStore } from "./ports.js";
import type { SessionId, SessionRecord } from "./types.js";

/** Headless session store for tests and composition before durable storage is selected. */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<SessionId, SessionRecord>();

  async list(): Promise<readonly SessionRecord[]> {
    return [...this.sessions.values()].map(cloneSession);
  }

  async get(sessionId: SessionId): Promise<SessionRecord | undefined> {
    const session = this.sessions.get(sessionId);
    return session === undefined ? undefined : cloneSession(session);
  }

  async save(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, cloneSession(session));
  }

  async remove(sessionId: SessionId): Promise<void> {
    this.sessions.delete(sessionId);
  }
}

function cloneSession(session: SessionRecord): SessionRecord {
  return {
    ...session,
    messages: session.messages.map((message) => ({
      ...message,
      ...(message.metadata === undefined ? {} : { metadata: { ...message.metadata } }),
    })),
    continuations: session.continuations.map((continuation) => ({ ...continuation })),
  };
}
