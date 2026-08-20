import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { ProjectIdentity } from "../domain/types.js";
import { MemoryDatabase } from "../storage/database.js";

interface ProjectFile {
  project_id: string;
  name: string;
  workspace: string;
  created_at: string;
}

export interface ResolveProjectOptions {
  cwd: string;
  createIfMissing?: boolean;
  name?: string;
}

function slugify(value: string): string {
  const slug = value.normalize("NFKC").toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-|-$/g, "");
  return slug || `project-${randomUUID().slice(0, 8)}`;
}

function findIdentityFile(start: string): string | null {
  let cursor = resolve(start);
  while (true) {
    const candidate = join(cursor, ".memorygraph", "project.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function parseProjectFile(path: string): ProjectFile {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object") throw new Error(`Invalid project identity file: ${path}`);
  const value = raw as Record<string, unknown>;
  for (const key of ["project_id", "name", "workspace", "created_at"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) throw new Error(`Missing ${key} in ${path}`);
  }
  return value as unknown as ProjectFile;
}

export class ProjectResolver {
  constructor(private readonly database: MemoryDatabase) {}

  resolve(options: ResolveProjectOptions): ProjectIdentity {
    const cwd = resolve(options.cwd);
    const identityPath = findIdentityFile(cwd);
    if (identityPath) {
      const config = parseProjectFile(identityPath);
      const existing = this.database.getProject(config.project_id);
      const root = dirname(dirname(identityPath));
      if (existing) {
        this.database.addProjectRoot(existing.projectId, root, existing.primaryRoot === "");
        return this.database.getProject(existing.projectId) ?? existing;
      }
      return this.database.createProject({
        projectId: config.project_id,
        workspaceId: config.workspace,
        name: config.name,
        slug: slugify(config.name),
        root,
      });
    }

    const registered = this.database.findProjectForPath(cwd);
    if (registered) return registered;
    if (!options.createIfMissing) throw new Error(`No MemoryGraph project found for ${cwd}`);

    const name = options.name?.trim() || basename(cwd);
    const project = this.database.createProject({ name, slug: slugify(name), root: cwd });
    const directory = join(cwd, ".memorygraph");
    mkdirSync(directory, { recursive: true });
    const file: ProjectFile = {
      project_id: project.projectId,
      name: project.name,
      workspace: project.workspaceId,
      created_at: project.createdAt,
    };
    writeFileSync(join(directory, "project.json"), `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return project;
  }

  attachRoot(projectId: string, root: string, primary = false): ProjectIdentity {
    const project = this.database.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const normalized = resolve(root);
    const alreadyAttached = this.database.findProjectForPath(normalized);
    if (alreadyAttached && alreadyAttached.projectId !== projectId) {
      throw new Error(`${normalized} is already inside project ${alreadyAttached.name}`);
    }
    const directory = join(normalized, ".memorygraph");
    const identityPath = join(directory, "project.json");
    if (existsSync(identityPath)) {
      const existing = parseProjectFile(identityPath);
      if (existing.project_id !== projectId) throw new Error(`${identityPath} belongs to another MemoryGraph project`);
    } else {
      mkdirSync(directory, { recursive: true });
      const file: ProjectFile = {
        project_id: projectId,
        name: project.name,
        workspace: project.workspaceId,
        created_at: project.createdAt,
      };
      writeFileSync(identityPath, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    }
    this.database.addProjectRoot(projectId, normalized, primary);
    return this.database.getProject(projectId) ?? project;
  }
}
