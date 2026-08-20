import { homedir } from "node:os";

import type { AdapterSyncResult, ProjectIdentity } from "../domain/types.js";
import { MemoryDatabase } from "../storage/database.js";
import { CodexAdapter } from "./codex-adapter.js";
import { CommandCodeAdapter } from "./command-code-adapter.js";
import { OpenCodeAdapter } from "./opencode-adapter.js";
import { TraeAdapter } from "./trae-adapter.js";
import { WorkBuddyAdapter } from "./workbuddy-adapter.js";
import type { AgentAdapter, ProjectSyncService } from "./types.js";

export class AdapterRegistry implements ProjectSyncService {
  constructor(readonly adapters: AgentAdapter[]) {}

  syncProject(project: ProjectIdentity): AdapterSyncResult[] {
    return this.adapters.map((adapter) => {
      try {
        return adapter.sync(project);
      } catch (error) {
        return {
          adapterId: adapter.id,
          sourceKey: project.primaryRoot,
          scanned: 0,
          ingested: 0,
          skipped: 0,
          cursor: {},
          warnings: [error instanceof Error ? error.message : String(error)],
        };
      }
    });
  }
}

export function createDefaultAdapterRegistry(database: MemoryDatabase): AdapterRegistry {
  const userDirectory = homedir();
  return new AdapterRegistry([
    new CodexAdapter(database, `${userDirectory}/.codex/sessions`),
    new OpenCodeAdapter(database, `${userDirectory}/.local/share/opencode/opencode.db`),
    new CommandCodeAdapter(database, `${userDirectory}/.commandcode/projects`),
    new WorkBuddyAdapter(database, `${userDirectory}/.workbuddy`),
    new TraeAdapter(database),
  ]);
}
