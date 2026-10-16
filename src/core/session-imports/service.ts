import { sameImportProject } from "./project-path.js";

import { InvalidSessionError } from "../sessions/errors.js";
import type { ProjectsService } from "../projects/service.js";
import type { SessionsService } from "../sessions/service.js";
import type { LocalSessionSource } from "./ports.js";
import type { ExternalSessionSnapshot, ImportSessionResult, SessionDiscovery } from "./types.js";

/**
 * Discovers and imports external history into a project's application sessions.
 * Sources own provider parsing. This coordinator validates folder ownership,
 * reports partial failures, and serializes imports to prevent duplicate copies.
 * Imported native IDs are provenance, not native resume associations: account
 * isolation means their runtime state may not exist in Rack's account context.
 */
export class SessionImportsService {
  private readonly sources = new Map<string, LocalSessionSource>();
  private importChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly projects: ProjectsService,
    private readonly sessions: SessionsService,
    sources: readonly LocalSessionSource[],
  ) {
    for (const source of sources) this.sources.set(source.sourceId, source);
  }

  async discover(projectId: string): Promise<SessionDiscovery> {
    const project = await this.projects.getProject(projectId);
    const existing = await this.sessions.list(project.id);
    const sessions: SessionDiscovery["sessions"][number][] = [];
    const failures: SessionDiscovery["failures"][number][] = [];
    await Promise.all([...this.sources.values()].map(async (source) => {
      try {
        for (const candidate of await source.list(project.path)) {
          if (!sameImportProject(candidate.projectPath, project.path)) continue;
          const imported = existing.find((session) => session.importSource?.sourceId === source.sourceId
            && session.importSource.nativeSessionId === candidate.nativeSessionId);
          sessions.push({ ...candidate, ...(imported === undefined ? {} : { importedSessionId: imported.id }) });
        }
      } catch {
        // Do not surface provider diagnostics, which can include private paths
        // or config details. One unavailable source does not hide the other.
        failures.push({ sourceId: source.sourceId, providerName: source.providerName, message: `${source.providerName} history could not be read. Check that its local runtime is installed and accessible, then refresh.` });
      }
    }));
    return { sessions: sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), failures };
  }

  async preview(projectId: string, sourceId: string, nativeSessionId: string): Promise<ExternalSessionSnapshot> {
    const project = await this.projects.getProject(projectId);
    const source = this.sources.get(sourceId);
    if (source === undefined) throw new InvalidSessionError("Unknown session import source.");
    const snapshot = await source.read(project.path, nativeSessionId);
    if (snapshot.session.sourceId !== sourceId || snapshot.session.nativeSessionId !== nativeSessionId
        || !sameImportProject(snapshot.session.projectPath, project.path)) {
      throw new InvalidSessionError("The external session does not belong to this project folder.");
    }
    return snapshot;
  }

  import(projectId: string, sourceId: string, nativeSessionId: string): Promise<ImportSessionResult> {
    const next = this.importChain.then(async () => {
      const project = await this.projects.getProject(projectId);
      const existing = (await this.sessions.list(project.id)).find((session) =>
        session.importSource?.sourceId === sourceId && session.importSource.nativeSessionId === nativeSessionId);
      if (existing !== undefined) return { session: existing, alreadyImported: true };
      const snapshot = await this.preview(project.id, sourceId, nativeSessionId);
      if (!snapshot.messages.some((message) => message.role === "user" || message.role === "assistant")) {
        throw new InvalidSessionError("This session has no readable conversation to import.");
      }
      const session = await this.sessions.importSnapshot(project.id, snapshot);
      return { session, alreadyImported: false };
    });
    this.importChain = next.then(() => undefined, () => undefined);
    return next;
  }
}
