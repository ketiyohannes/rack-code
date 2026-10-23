import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { JsonFileDocument } from "./json-file.js";
import type { ProjectStore } from "@rack/core/projects/ports";
import type { ProjectRecord, ProjectId } from "@rack/core/projects/types";

interface ProjectDocument {
  readonly schemaVersion: 4;
  readonly projects: ProjectRecord[];
  /** Former duplicate IDs resolve to their one surviving folder identity. */
  readonly aliases: Readonly<Record<string, string>>;
}

interface LegacyFolder extends ProjectRecord {
  readonly projectId?: string;
  readonly kind?: string;
}

interface LegacyDocument {
  readonly schemaVersion: number;
  readonly projects?: readonly {
    readonly id: string;
    readonly rootPath: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  }[];
  readonly workspaces?: readonly LegacyFolder[];
}

/**
 * Stores the single project/folder identity in projects.json (schema 4).
 *
 * Earlier releases used either project/child-workspace records or a standalone
 * workspaces.json. Import all saved folders before the first write, preserving
 * workspace IDs as project IDs so sessions, runs, locks, and native resumes
 * keep their associations. A partial workspace-only import must not hide
 * folders still present in the older document. The newer folder record wins
 * when both sources contain the same ID. Duplicate paths are consolidated
 * with persistent ID aliases, which session and execution stores use to
 * update their references without losing history. Canonical documents are
 * authoritative thereafter; workspaces.json is never re-imported.
 */
export class JsonProjectStore implements ProjectStore {
  private readonly document: JsonFileDocument<ProjectDocument>;

  constructor(filePath: string, legacyWorkspaceFilePath?: string) {
    this.document = new JsonFileDocument<ProjectDocument>(
      filePath,
      { schemaVersion: 4, projects: [], aliases: {} },
      async (stored, missing) => {
        const current = stored as ProjectDocument | LegacyDocument;
        // A missing file starts at schema 4 with no records. Import the old
        // workspace file in that case too; the envelope becomes authoritative
        // once written, including an intentionally empty project list.
        if (current.schemaVersion === 4 && !missing) {
          return current as ProjectDocument;
        }
        if (current.schemaVersion === 3 && !missing) {
          return consolidateProjects((current as unknown as { projects: ProjectRecord[] }).projects);
        }
        if (!missing && current.schemaVersion !== 1) {
          throw new Error(`Unsupported projects schema version: ${current.schemaVersion}.`);
        }
        const legacy = current as LegacyDocument;
        const projects = new Map<string, ProjectRecord>();
        for (const folder of legacy.workspaces ?? []) {
          projects.set(folder.id, projectFromFolder(folder));
        }
        const workspacePath = legacyWorkspaceFilePath ?? filePath.replace(/projects\.json$/, "workspaces.json");
        const standalone = await readLegacyDocument(workspacePath);
        if (standalone !== undefined && standalone.schemaVersion !== 2) {
          throw new Error(`Unsupported legacy workspaces schema version: ${standalone.schemaVersion}.`);
        }
        for (const folder of standalone?.workspaces ?? []) {
          projects.set(folder.id, projectFromFolder(folder));
        }
        // A legacy project created without its root workspace still represents
        // a chosen folder. Retain it; projects already represented by a child
        // folder need no second identity in the migrated model.
        for (const root of legacy.projects ?? []) {
          const hasFolder = (legacy.workspaces ?? []).some((folder) => folder.projectId === root.id || folder.path === root.rootPath)
            || [...projects.values()].some((project) => project.path === root.rootPath);
          if (!hasFolder) {
            projects.set(root.id, {
              id: root.id, path: root.rootPath, createdAt: root.createdAt, updatedAt: root.updatedAt,
            });
          }
        }
        return consolidateProjects([...projects.values()]);
      },
    );
  }

  async listProjects(): Promise<readonly ProjectRecord[]> {
    return (await this.document.read()).projects;
  }

  async getProject(projectId: ProjectId): Promise<ProjectRecord | undefined> {
    const current = await this.document.read();
    const canonicalId = current.aliases[projectId] ?? projectId;
    return current.projects.find((project) => project.id === canonicalId);
  }

  async saveProject(project: ProjectRecord): Promise<void> {
    await this.document.update((current) => ({
      ...current,
      projects: [...current.projects.filter((candidate) => candidate.id !== project.id), project],
    }));
  }
}

/**
 * Keep the oldest ID for each normalized folder and retain every former ID as
 * an alias. Newer metadata wins, but writer ownership is never silently lost;
 * two different active writers need recovery before the folder can be merged.
 */
function consolidateProjects(records: readonly ProjectRecord[]): ProjectDocument {
  const byPath = new Map<string, ProjectRecord>();
  const aliases: Record<string, string> = {};
  const ordered = [...records].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const source of ordered) {
    const record = projectFromFolder(source);
    const path = resolve(record.path);
    const existing = byPath.get(path);
    if (existing === undefined) {
      byPath.set(path, { ...record, path });
      continue;
    }
    if (existing.activeWriterAttemptId !== undefined && record.activeWriterAttemptId !== undefined
        && existing.activeWriterAttemptId !== record.activeWriterAttemptId) {
      throw new Error(`Cannot merge project folder '${path}' while two editing attempts own it.`);
    }
    aliases[record.id] = existing.id;
    const newest = record.updatedAt > existing.updatedAt ? record : existing;
    const writer = existing.activeWriterAttemptId ?? record.activeWriterAttemptId;
    const startingRevision = newest.startingRevision ?? existing.startingRevision ?? record.startingRevision;
    byPath.set(path, {
      ...newest, id: existing.id, path, createdAt: existing.createdAt,
      ...(writer === undefined ? {} : { activeWriterAttemptId: writer }),
      ...(startingRevision === undefined ? {} : { startingRevision }),
    });
  }
  return { schemaVersion: 4, projects: [...byPath.values()], aliases };
}

/** Select only canonical fields; obsolete grouping and kind never escape. */
function projectFromFolder(folder: LegacyFolder): ProjectRecord {
  return {
    id: folder.id,
    path: folder.path,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
    ...(folder.startingRevision === undefined ? {} : { startingRevision: folder.startingRevision }),
    ...(folder.activeWriterAttemptId === undefined ? {} : { activeWriterAttemptId: folder.activeWriterAttemptId }),
  };
}

/** Missing legacy files are normal; malformed or unreadable data is an error. */
async function readLegacyDocument(filePath: string): Promise<LegacyDocument | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as LegacyDocument;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
