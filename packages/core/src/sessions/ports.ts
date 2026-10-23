import type { SessionId, SessionRecord, SessionSummary } from "./types.js";

export interface SessionStore {
  list(): Promise<readonly SessionRecord[]>;
  /** Optional projected query for stores that can avoid copying message bodies. */
  listSummaries?(): Promise<readonly SessionSummary[]>;
  get(sessionId: SessionId): Promise<SessionRecord | undefined>;
  save(session: SessionRecord): Promise<void>;
  /** Removes the saved conversation; execution audit and artifacts have separate owners. */
  remove(sessionId: SessionId): Promise<void>;
}
