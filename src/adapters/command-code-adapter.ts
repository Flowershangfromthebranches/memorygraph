import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

import type { AdapterSyncResult, EventKind, ProjectIdentity } from "../domain/types.js";
import { MemoryDatabase } from "../storage/database.js";
import { readFirstJsonObject, readJsonLines } from "./jsonl.js";
import { protectedMessage, sanitizeForPolicy } from "./redaction.js";
import type { AgentAdapter } from "./types.js";

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function inside(path: string, root: string): boolean { const candidate = resolve(path); const base = resolve(root); return candidate === base || candidate.startsWith(`${base}${sep}`); }

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.endsWith(".checkpoints.jsonl")) found.push(path);
    }
  };
  walk(root);
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

export class CommandCodeAdapter implements AgentAdapter {
  readonly id = "command-code";
  constructor(private readonly database: MemoryDatabase, private readonly projectsRoot = `${homedir()}/.commandcode/projects`) {}

  sync(project: ProjectIdentity): AdapterSyncResult {
    const result: AdapterSyncResult = { adapterId: this.id, sourceKey: this.projectsRoot, scanned: 0, ingested: 0, skipped: 0, cursor: {}, warnings: [] };
    const privacy = this.database.getPrivacyPolicy(project.projectId);
    for (const path of files(this.projectsRoot)) {
      result.scanned += 1;
      const meta = readFirstJsonObject(path);
      const cwd = typeof meta?.cwd === "string" ? meta.cwd : null;
      if (!cwd || !inside(cwd, project.primaryRoot)) { result.skipped += 1; continue; }
      const externalId = typeof meta?.id === "string" ? meta.id : hash(path).slice(0, 24);
      const startedAt = typeof meta?.timestamp === "string" ? meta.timestamp : new Date(statSync(path).birthtimeMs).toISOString();
      const cursor = this.database.getCursor(this.id, path);
      const chunk = readJsonLines(path, typeof cursor?.offset === "number" ? cursor.offset : 0);
      const sessionId = this.database.upsertSession({ projectId: project.projectId, agentId: this.id, externalId, cwd, startedAt, sourceUri: `command-code://session/${externalId}`, lastCursor: String(chunk.nextOffset) });
      this.database.linkSessionGraph({ projectId: project.projectId, projectName: project.name, agentId: this.id, sessionId, externalId, startedAt });
      for (const line of chunk.lines) {
        const record = line.value;
        if (record.type !== "message") continue;
        const message = object(record.message);
        if (!message || !Array.isArray(message.content)) continue;
        const role = typeof message.role === "string" ? message.role : "agent";
        for (let partIndex = 0; partIndex < message.content.length; partIndex += 1) {
          const part = object(message.content[partIndex]);
          if (!part || typeof part.type !== "string") continue;
          let kind: EventKind | null = null;
          let summaryText = "";
          let eventPayload: Record<string, unknown> = {};
          if (part.type === "text" && typeof part.text === "string") {
            const protectedContent = protectedMessage(role, part.text, privacy);
            kind = "message"; summaryText = protectedContent.summary; eventPayload = protectedContent.payload;
          } else if (part.type === "tool_use") {
            const name = typeof part.name === "string" ? part.name : "unknown";
            kind = name.includes("write") || name.includes("edit") ? "file_change" : name.includes("shell") ? "command" : "tool_call";
            summaryText = `Tool: ${name}`; eventPayload = { role, name, input: sanitizeForPolicy(part.input, privacy), callId: part.id ?? null };
          } else if (part.type === "tool_result") {
            kind = "tool_call"; summaryText = "Tool result"; eventPayload = { role, callId: part.tool_use_id ?? null, outputLength: JSON.stringify(part.content ?? null).length };
          }
          if (!kind) continue;
          const timestamp = typeof record.timestamp === "string" ? record.timestamp : startedAt;
          const sourceUri = `command-code://session/${externalId}/event/${line.start}/${partIndex}`;
          const event = this.database.appendEvent({ projectId: project.projectId, agentId: this.id, sessionId, kind, occurredAt: timestamp, sourceUri, sourceOffset: `${line.start}:${partIndex}`, dedupeKey: hash(`${this.id}\0${path}\0${line.start}\0${partIndex}`), summary: summaryText, payload: eventPayload });
          this.database.addEvidence({ projectId: project.projectId, eventId: event.id, uri: sourceUri, kind: "adapter", locator: { path, byteOffset: line.start, partIndex } });
          result.ingested += 1;
        }
      }
      this.database.setCursor(this.id, path, { offset: chunk.nextOffset, size: chunk.size, mtimeMs: chunk.mtimeMs, sessionId: externalId });
      result.cursor = { lastSource: path, offset: chunk.nextOffset };
    }
    return result;
  }
}
