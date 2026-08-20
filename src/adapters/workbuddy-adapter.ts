import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

import type { AdapterSyncResult, EventKind, ProjectIdentity } from "../domain/types.js";
import { MemoryDatabase } from "../storage/database.js";
import { readFirstJsonObject, readJsonLines } from "./jsonl.js";
import { protectedMessage, sanitizeForPolicy, summarize } from "./redaction.js";
import type { AgentAdapter } from "./types.js";

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function inside(path: string, root: string): boolean { const candidate = resolve(path); const base = resolve(root); return candidate === base || candidate.startsWith(`${base}${sep}`); }

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((value) => {
    const part = object(value);
    return part && typeof part.text === "string" ? part.text : "";
  }).filter(Boolean).join("\n");
}

function projectFiles(root: string): string[] {
  const projects = `${root}/projects`;
  if (!existsSync(projects)) return [];
  const output: string[] = [];
  for (const directory of readdirSync(projects, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const path = `${projects}/${directory.name}`;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(`${path}/${entry.name}`);
    }
  }
  return output.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function matches(path: string, cwd: string, projectRoot: string): boolean {
  if (inside(cwd, projectRoot)) return true;
  if (!inside(projectRoot, cwd)) return false;
  return readFileSync(path, "utf8").includes(projectRoot);
}

export class WorkBuddyAdapter implements AgentAdapter {
  readonly id = "workbuddy";
  constructor(private readonly database: MemoryDatabase, private readonly root = `${homedir()}/.workbuddy`) {}

  sync(project: ProjectIdentity): AdapterSyncResult {
    const result: AdapterSyncResult = { adapterId: this.id, sourceKey: this.root, scanned: 0, ingested: 0, skipped: 0, cursor: {}, warnings: [] };
    const privacy = this.database.getPrivacyPolicy(project.projectId);
    for (const path of projectFiles(this.root)) {
      result.scanned += 1;
      const first = readFirstJsonObject(path);
      const cwd = typeof first?.cwd === "string" ? first.cwd : null;
      if (!cwd || !matches(path, cwd, project.primaryRoot)) { result.skipped += 1; continue; }
      const externalId = typeof first?.sessionId === "string" ? first.sessionId : hash(path).slice(0, 24);
      const startedAt = typeof first?.timestamp === "string" ? first.timestamp : new Date(statSync(path).birthtimeMs).toISOString();
      const cursor = this.database.getCursor(this.id, path);
      const chunk = readJsonLines(path, typeof cursor?.offset === "number" ? cursor.offset : 0);
      const sessionId = this.database.upsertSession({ projectId: project.projectId, agentId: this.id, externalId, cwd, startedAt, sourceUri: `workbuddy://session/${externalId}`, lastCursor: String(chunk.nextOffset) });
      this.database.linkSessionGraph({ projectId: project.projectId, projectName: project.name, agentId: this.id, sessionId, externalId, startedAt });
      for (const line of chunk.lines) {
        const record = line.value;
        const type = typeof record.type === "string" ? record.type : "unknown";
        let kind: EventKind | null = null;
        let summaryText = "";
        let payload: Record<string, unknown> = {};
        if (type === "message") {
          const body = extractText(record.content);
          if (!body) continue;
          const role = typeof record.role === "string" ? record.role : "agent";
          const protectedContent = protectedMessage(role, body, privacy);
          kind = "message"; summaryText = protectedContent.summary; payload = { ...protectedContent.payload, status: record.status ?? null };
        } else if (type === "function_call") {
          const name = typeof record.name === "string" ? record.name : "unknown";
          kind = ["Edit", "Write"].includes(name) ? "file_change" : name === "Bash" ? "command" : "tool_call";
          summaryText = `Tool: ${name}`; payload = { name, arguments: sanitizeForPolicy(record.arguments, privacy), callId: record.callId ?? null };
        } else if (type === "function_call_result") {
          kind = "tool_call"; summaryText = `Tool result: ${typeof record.name === "string" ? record.name : "unknown"}`; payload = { callId: record.callId ?? null, outputLength: JSON.stringify(record.output ?? null).length, status: record.status ?? null };
        } else if (type === "file-history-snapshot") {
          kind = "file_change"; summaryText = "File history snapshot"; payload = { snapshot: sanitizeForPolicy(record.snapshot, privacy), isSnapshotUpdate: record.isSnapshotUpdate ?? false };
        } else if (type === "ai-title") {
          kind = "session"; summaryText = typeof record.aiTitle === "string" ? `Session: ${summarize(record.aiTitle)}` : "WorkBuddy session";
        }
        if (!kind) continue;
        const occurredAt = typeof record.timestamp === "string" ? record.timestamp : startedAt;
        const sourceUri = `workbuddy://session/${externalId}/event/${line.start}`;
        const event = this.database.appendEvent({ projectId: project.projectId, agentId: this.id, sessionId, kind, occurredAt, sourceUri, sourceOffset: String(line.start), dedupeKey: hash(`${this.id}\0${path}\0${line.start}`), summary: summaryText, payload });
        this.database.addEvidence({ projectId: project.projectId, eventId: event.id, uri: sourceUri, kind: "adapter", locator: { path, byteOffset: line.start } });
        result.ingested += 1;
      }
      this.database.setCursor(this.id, path, { offset: chunk.nextOffset, size: chunk.size, mtimeMs: chunk.mtimeMs, sessionId: externalId });
      result.cursor = { lastSource: path, offset: chunk.nextOffset };
    }
    return result;
  }
}
