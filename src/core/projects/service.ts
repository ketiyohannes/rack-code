import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  InvalidProjectError,
  ProjectBusyError,
  ProjectNotFoundError,
} from "./errors.js";
import type { ProjectChangesReader, ProjectStore } from "./ports.js";
import type { CreateProjectInput, ProjectId, ProjectRecord } from "./types.js";

export interface ProjectsServiceOptions {
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly changes?: ProjectChangesReader;
}

/**
 * Owns top-level project identity and writer ownership.
 *
 * A project is the product's unit of folder context. Sessions, model
 * discovery, execution paths, and concurrency all reference this record
 * directly. "Workspace" is another name for this same project, not a second
 * record or identity. Future isolated execution directories belong to a
 * project rather than creating another folder hierarchy.
 */
export class ProjectsService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly changes: ProjectChangesReader | undefined;
  /** Serializes folder creation and writer changes within this execution host. */
  private mutation: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: ProjectStore,
    options: ProjectsServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.changes = options.changes;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    if (input.path.trim() === "") {
      throw new InvalidProjectError("Project path is required.");
    }
    return this.mutate(async () => {
      // Native pickers return absolute paths. Normalize separators, dot segments
      // and trailing slashes so adding that folder again reuses its identity.
      const path = resolve(input.path);
      const existing = (await this.store.listProjects()).find((project) => resolve(project.path) === path);
      if (existing !== undefined) return existing;
      const timestamp = this.now().toISOString();
      const project: ProjectRecord = {
        id: input.id ?? this.createId(),
        path,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(input.startingRevision === undefined ? {} : { startingRevision: input.startingRevision }),
      };
      await this.store.saveProject(project);
      return project;
    });
  }

  /** Lists projects in creation order for the navigator. */
  async listProjects(): Promise<readonly ProjectRecord[]> {
    const projects = await this.store.listProjects();
    return [...projects].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getProject(projectId: ProjectId): Promise<ProjectRecord> {
    const project = await this.store.getProject(projectId);
    if (project === undefined) throw new ProjectNotFoundError(projectId);
    return project;
  }

  /** Resolve the saved folder first; clients cannot request arbitrary paths. */
  async getChanges(projectId: ProjectId, repositoryPath?: string): Promise<import("./types.js").ProjectChanges> {
    const project = await this.getProject(projectId);
    if (!this.changes) return { status: "unavailable", diff: "", truncated: false };
    return repositoryPath === undefined ? this.changes.read(project.path) : this.changes.readRepository(project.path, repositoryPath);
  }

  /** Discover repositories for the view without changing execution's project path. */
  async discoverRepositories(projectId: ProjectId, options: import("./types.js").RepositoryDiscoveryOptions = {}): Promise<import("./types.js").ProjectRepositories> {
    const project = await this.getProject(projectId);
    if (!this.changes) return { paths: [], limited: false, warnings: ["Repository discovery is unavailable."] };
    return this.changes.discover(project.path, options);
  }

  /** Called once before a new host accepts work. Old process-owned locks cannot be live here. */
  async recoverAbandonedWriters(): Promise<void> {
    await this.mutate(async () => {
      for (const project of await this.store.listProjects()) {
        if (project.activeWriterAttemptId === undefined) continue;
        const { activeWriterAttemptId: _oldOwner, ...rest } = project;
        await this.store.saveProject({ ...rest, updatedAt: this.now().toISOString() });
      }
    });
  }

  async acquireWriter(projectId: ProjectId, attemptId: string): Promise<ProjectRecord> {
    return this.mutate(async () => {
      const project = await this.getProject(projectId);
      if (project.activeWriterAttemptId !== undefined && project.activeWriterAttemptId !== attemptId) {
        throw new ProjectBusyError(projectId, project.activeWriterAttemptId);
      }
      const updated: ProjectRecord = {
        ...project,
        activeWriterAttemptId: attemptId,
        updatedAt: this.now().toISOString(),
      };
      await this.store.saveProject(updated);
      return updated;
    });
  }

  async releaseWriter(projectId: ProjectId, attemptId: string): Promise<ProjectRecord> {
    return this.mutate(async () => {
      const project = await this.getProject(projectId);
      if (project.activeWriterAttemptId !== undefined && project.activeWriterAttemptId !== attemptId) {
        throw new ProjectBusyError(projectId, project.activeWriterAttemptId);
      }
      const { activeWriterAttemptId: _activeWriterAttemptId, ...withoutWriter } = project;
      const updated: ProjectRecord = { ...withoutWriter, updatedAt: this.now().toISOString() };
      await this.store.saveProject(updated);
      return updated;
    });
  }

  /** A rejected mutation must not block later commands. */
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(operation);
    this.mutation = next.then(() => undefined, () => undefined);
    return next;
  }
}
