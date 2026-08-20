import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { sep } from "node:path";

import BetterSqlite3 from "better-sqlite3";

import type { AdapterSyncResult, EventKind, ProjectIdentity } from "../domain/types.js";
import { MemoryDatabase } from "../storage/database.js";
import { protectedMessage, sanitizeForPolicy } from "./redaction.js";
import type { AgentAdapter } from "./types.js";

type Row = Record<string, unknown>;
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function jsonObject(value: unknown): Record<string, unknown> { if (typeof value !== "string") return {}; try { return object(JSON.parse(value) as unknown) ?? {}; } catch { return {}; } }
function string(row: Row, key: string): string { return typeof row[key] === "string" ? row[key] as string : ""; }
function numeric(row: Row, key: string): number { return typeof row[key] === "number" ? row[key] as number : 0; }

export class OpenCodeAdapter implements AgentAdapter {
  readonly id = "opencode";
  constructor(private readonly database: MemoryDatabase, private readonly sourcePath = `${homedir()}/.local/share/opencode/opencode.db`) {}

  sync(project: ProjectIdentity): AdapterSyncResult {
    const result: AdapterSyncResult = { adapterId: this.id, sourceKey: this.sourcePath, scanned: 0, ingested: 0, skipped: 0, cursor: {}, warnings: [] };
    const privacy = this.database.getPrivacyPolicy(project.projectId);
    if (!existsSync(this.sourcePath)) { result.warnings.push("OpenCode database not found."); return result; }
    const source = new BetterSqlite3(this.sourcePath, { readonly: true, fileMustExist: true });
    try {
      const sourceKey = `${this.sourcePath}#${project.projectId}`;
      const cursor = this.database.getCursor(this.id, sourceKey);
      const lastUpdated = typeof cursor?.timeUpdated === "number" ? cursor.timeUpdated : 0;
      const lastPartId = typeof cursor?.partId === "string" ? cursor.partId : "";
      const prefix = `${project.primaryRoot}${sep}%`;
      const rows = source.prepare(
        `SELECT s.id AS session_id, s.directory, s.title, s.time_created AS session_created, s.time_updated AS session_updated,
                m.id AS message_id, m.data AS message_data,
                p.id AS part_id, p.data AS part_data, p.time_created AS part_created, p.time_updated AS part_updated
         FROM session s JOIN message m ON m.session_id=s.id JOIN part p ON p.message_id=m.id
         WHERE (s.directory=? OR s.directory LIKE ?) AND (p.time_updated>? OR (p.time_updated=? AND p.id>?))
         ORDER BY p.time_updated, p.id`,
      ).all(project.primaryRoot, prefix, lastUpdated, lastUpdated, lastPartId) as Row[];
      result.scanned = rows.length;
      let maxUpdated = lastUpdated;
      let maxPartId = lastPartId;
      for (const row of rows) {
        const externalId = string(row, "session_id");
        const partId = string(row, "part_id");
        const partUpdated = numeric(row, "part_updated");
        const startedAt = new Date(numeric(row, "session_created")).toISOString();
        const sessionId = this.database.upsertSession({
          projectId: project.projectId,
          agentId: this.id,
          externalId,
          cwd: string(row, "directory"),
          startedAt,
          endedAt: new Date(numeric(row, "session_updated")).toISOString(),
          sourceUri: `opencode://session/${externalId}`,
          lastCursor: `${partUpdated}:${partId}`,
          summary: string(row, "title"),
          status: "complete",
        });
        this.database.linkSessionGraph({ projectId: project.projectId, projectName: project.name, agentId: this.id, sessionId, externalId, title: string(row, "title"), startedAt });
        const message = jsonObject(row.message_data);
        const part = jsonObject(row.part_data);
        const type = typeof part.type === "string" ? part.type : "unknown";
        const role = typeof message.role === "string" ? message.role : "agent";
        let kind: EventKind | null = null;
        let summaryText = "";
        let payload: Record<string, unknown> = {};
        if (type === "text" && typeof part.text === "string") {
          const protectedContent = protectedMessage(role, part.text, privacy);
          kind = "message"; summaryText = protectedContent.summary; payload = protectedContent.payload;
        } else if (type === "tool") {
          const tool = typeof part.tool === "string" ? part.tool : "unknown";
          kind = tool.includes("write") || tool.includes("edit") || tool.includes("patch") ? "file_change" : tool.includes("bash") ? "command" : "tool_call";
          summaryText = `Tool: ${tool}`; payload = { role, tool, state: sanitizeForPolicy(part.state, privacy), callId: part.callID ?? null };
        } else if (type === "patch") {
          kind = "file_change"; summaryText = "Patch applied"; payload = { role, files: sanitizeForPolicy(part.files, privacy), hash: part.hash ?? null };
        } else if (type === "step-finish" || type === "compaction") {
          kind = "checkpoint"; summaryText = type === "compaction" ? "Session compacted" : "Agent step finished"; payload = { role, reason: part.reason ?? null, cost: part.cost ?? null, tokens: sanitizeForPolicy(part.tokens, privacy) };
        }
        if (kind) {
          const occurredAt = new Date(numeric(row, "part_created") || partUpdated).toISOString();
          const sourceUri = `opencode://session/${externalId}/part/${partId}`;
          const event = this.database.appendEvent({ projectId: project.projectId, agentId: this.id, sessionId, kind, occurredAt, sourceUri, sourceOffset: `${partUpdated}:${partId}`, dedupeKey: hash(`${this.id}\0${externalId}\0${partId}`), summary: summaryText, payload });
          this.database.addEvidence({ projectId: project.projectId, eventId: event.id, uri: sourceUri, kind: "adapter", locator: { database: this.sourcePath, sessionId: externalId, messageId: string(row, "message_id"), partId } });
          result.ingested += 1;
        } else {
          result.skipped += 1;
        }
        if (partUpdated > maxUpdated || (partUpdated === maxUpdated && partId > maxPartId)) { maxUpdated = partUpdated; maxPartId = partId; }
      }
      const nextCursor = { timeUpdated: maxUpdated, partId: maxPartId };
      this.database.setCursor(this.id, sourceKey, nextCursor);
      result.cursor = nextCursor;
      return result;
    } finally {
      source.close();
    }
  }
}
