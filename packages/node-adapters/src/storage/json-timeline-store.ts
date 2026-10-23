import { JsonFileDocument } from "./json-file.js";
import type { TimelineSessionState, TimelineStore, TimelineProjectState } from "@rack/features/timeline";

/**
 * Timeline's own document, separate from sessions and execution records so
 * the optional feature never rewrites core data. Schema 1 holds per-session
 * enablement and the checkpoint index, plus optional per-project recording
 * preferences; snapshot contents stay in Git. Missing project settings in
 * older documents mean automatic project recording is enabled.
 */
interface TimelineDocument {
  readonly schemaVersion: 1;
  readonly sessions: Readonly<Record<string, TimelineSessionState>>;
  /** Additive schema-1 field; absent in earlier documents means automatic recording. */
  readonly projects?: Readonly<Record<string, TimelineProjectState>>;
}

export class JsonTimelineStore implements TimelineStore {
  private readonly document: JsonFileDocument<TimelineDocument>;

  constructor(filePath: string) {
    this.document = new JsonFileDocument<TimelineDocument>(filePath, { schemaVersion: 1, sessions: {} }, (stored) => {
      const version = (stored as { schemaVersion?: unknown }).schemaVersion;
      if (version !== 1) throw new Error("Unsupported timeline schema version.");
      return stored as TimelineDocument;
    });
  }

  async get(sessionId: string): Promise<TimelineSessionState | undefined> {
    const sessions = (await this.document.read()).sessions;
    return Object.prototype.hasOwnProperty.call(sessions, sessionId) ? sessions[sessionId] : undefined;
  }

  async getProject(projectId: string): Promise<TimelineProjectState | undefined> {
    const projects = (await this.document.read()).projects ?? {};
    return Object.prototype.hasOwnProperty.call(projects, projectId) ? projects[projectId] : undefined;
  }

  async saveProject(state: TimelineProjectState): Promise<void> {
    await this.document.update((current) => ({ ...current, projects: { ...current.projects, [state.projectId]: state } }));
  }

  async update(
    sessionId: string,
    change: (current: TimelineSessionState | undefined) => TimelineSessionState,
  ): Promise<TimelineSessionState> {
    let next: TimelineSessionState | undefined;
    await this.document.update((current) => {
      const existing = Object.prototype.hasOwnProperty.call(current.sessions, sessionId) ? current.sessions[sessionId] : undefined;
      next = change(existing);
      return { ...current, sessions: { ...current.sessions, [sessionId]: next } };
    });
    return next!;
  }
}
