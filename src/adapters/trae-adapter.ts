import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { AdapterSyncResult, ProjectIdentity } from "../domain/types.js";
import { MemoryDatabase } from "../storage/database.js";
import type { AgentAdapter } from "./types.js";

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function inside(path: string, root: string): boolean { const candidate = resolve(path); const base = resolve(root); return candidate === base || candidate.startsWith(`${base}${sep}`); }

interface TraeLocation { workspaceStorage: string; opaqueStore: string; }

function workspacePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { return value.startsWith("file:") ? fileURLToPath(value) : resolve(value); }
  catch { return null; }
}

export class TraeAdapter implements AgentAdapter {
  readonly id = "trae";
  constructor(private readonly database: MemoryDatabase, private readonly locations: TraeLocation[] = [
    {
      workspaceStorage: `${homedir()}/Library/Application Support/TRAE SOLO CN/User/workspaceStorage`,
      opaqueStore: `${homedir()}/Library/Application Support/TRAE SOLO CN/ModularData/ai-agent/database.db`,
    },
    {
      workspaceStorage: `${homedir()}/Library/Application Support/Trae CN/User/workspaceStorage`,
      opaqueStore: `${homedir()}/Library/Application Support/Trae CN/ModularData/ai-agent/database.db`,
    },
  ]) {}

  sync(project: ProjectIdentity): AdapterSyncResult {
    const result: AdapterSyncResult = { adapterId: this.id, sourceKey: "trae-workspace-storage", scanned: 0, ingested: 0, skipped: 0, cursor: {}, warnings: [] };
    let opaqueStoreObserved = false;
    for (const location of this.locations) {
      if (!existsSync(location.workspaceStorage)) continue;
      for (const entry of readdirSync(location.workspaceStorage, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const metadataPath = `${location.workspaceStorage}/${entry.name}/workspace.json`;
        if (!existsSync(metadataPath)) continue;
        result.scanned += 1;
        let metadata: Record<string, unknown>;
        try { metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>; }
        catch { result.skipped += 1; continue; }
        const cwd = workspacePath(metadata.workspace);
        if (!cwd || !inside(cwd, project.primaryRoot)) { result.skipped += 1; continue; }
        const stat = statSync(metadataPath);
        const externalId = entry.name;
        const occurredAt = stat.mtime.toISOString();
        const sessionId = this.database.upsertSession({
          projectId: project.projectId,
          agentId: this.id,
          externalId,
          cwd,
          startedAt: stat.birthtime.toISOString(),
          endedAt: occurredAt,
          sourceUri: `trae://workspace/${externalId}`,
          summary: `Trae workspace: ${basename(cwd)}`,
          status: "observed",
        });
        this.database.linkSessionGraph({ projectId: project.projectId, projectName: project.name, agentId: this.id, sessionId, externalId, title: `Trae workspace: ${basename(cwd)}`, startedAt: stat.birthtime.toISOString() });
        const sourceUri = `trae://workspace/${externalId}`;
        const event = this.database.appendEvent({
          projectId: project.projectId,
          agentId: this.id,
          sessionId,
          kind: "session",
          occurredAt,
          sourceUri,
          dedupeKey: hash(`${this.id}\0${metadataPath}\0${stat.mtimeMs}`),
          summary: `Trae workspace activity observed for ${basename(cwd)}`,
          payload: { cwd, workspaceMetadata: pathToFileURL(metadataPath).href, transcriptMode: "active-mcp-only" },
          confidence: 0.8,
        });
        this.database.addEvidence({ projectId: project.projectId, eventId: event.id, uri: pathToFileURL(metadataPath).href, kind: "adapter", locator: { workspaceId: externalId } });
        result.ingested += 1;
        result.cursor = { workspaceId: externalId, mtimeMs: stat.mtimeMs };
      }
      if (existsSync(location.opaqueStore)) {
        opaqueStoreObserved = true;
      }
    }
    if (opaqueStoreObserved) result.warnings.push("Trae native transcript storage is opaque or encrypted; passive sync is limited to workspace activity. Use the MemoryGraph MCP/Skill for live state capture.");
    return result;
  }
}
