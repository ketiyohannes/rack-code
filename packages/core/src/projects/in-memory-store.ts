import type { ProjectStore } from "./ports.js";
import type { ProjectId, ProjectRecord } from "./types.js";

/** Headless store used by unit tests and embedded callers. */
export class InMemoryProjectStore implements ProjectStore {
  private readonly projects = new Map<ProjectId, ProjectRecord>();

  async listProjects(): Promise<readonly ProjectRecord[]> {
    return [...this.projects.values()].map((project) => ({ ...project }));
  }

  async getProject(projectId: ProjectId): Promise<ProjectRecord | undefined> {
    const project = this.projects.get(projectId);
    return project === undefined ? undefined : { ...project };
  }

  async saveProject(project: ProjectRecord): Promise<void> {
    this.projects.set(project.id, { ...project });
  }
}
