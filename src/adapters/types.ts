import type { AdapterSyncResult, ProjectIdentity } from "../domain/types.js";

export interface AgentAdapter {
  readonly id: string;
  sync(project: ProjectIdentity): AdapterSyncResult;
}

export interface ProjectSyncService {
  syncProject(project: ProjectIdentity): AdapterSyncResult[];
}

