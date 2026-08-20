import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

import type { AdapterSyncResult, EventKind, ProjectIdentity } from "../domain/types.js";
import { MemoryDatabase } from "../storage/database.js";
import { readFirstJsonObject, readJsonLines } from "./jsonl.js";
import { protectedMessage, sanitizeForPolicy } from "./redaction.js";
import type { AgentAdapter } from "./types.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function recordObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function collectJsonl(root: string): string[] {
  if (!existsSync(root)) return [];
  const output: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(path);
    }
  };
  walk(root);
  return output.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function inside(path: string, root: string): boolean {
  const candidate = resolve(path);
  const normalizedRoot = resolve(root);
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}${sep}`);
}

function sessionMatchesProject(path: string, sessionCwd: string, projectRoot: string): boolean {
  if (inside(sessionCwd, projectRoot)) return true;
  if (!inside(projectRoot, sessionCwd)) return false;
  return readFileSync(path, "utf8").includes(projectRoot);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    const part = recordObject(item);
    return part && typeof part.text === "string" ? part.text : "";
  }).filter(Boolean).join("\n");
}

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex";

  constructor(
    private readonly database: MemoryDatabase,
    private readonly sessionsRoot = `${homedir()}/.codex/sessions`,
  ) {}

  sync(project: ProjectIdentity): AdapterSyncResult {
    const result: AdapterSyncResult = { adapterId: this.id, sourceKey: this.sessionsRoot, scanned: 0, ingested: 0, skipped: 0, cursor: {}, warnings: [] };
    const privacy = this.database.getPrivacyPolicy(project.projectId);
    const files = collectJsonl(this.sessionsRoot);
    for (const path of files) {
      result.scanned += 1;
      const first = readFirstJsonObject(path);
      const payload = recordObject(first?.payload);
      const cwd = typeof payload?.cwd === "string" ? payload.cwd : null;
      const source = recordObject(payload?.source);
      if (payload?.thread_source === "subagent" || source?.subagent !== undefined) {
        this.database.excludeEventsByEvidencePath(path, "Codex internal subagent session excluded from project memory");
        result.skipped += 1;
        continue;
      }
      if (!cwd || !sessionMatchesProject(path, cwd, project.primaryRoot)) { result.skipped += 1; continue; }
      const externalId = typeof payload?.id === "string" ? payload.id : typeof payload?.session_id === "string" ? payload.session_id : hash(path).slice(0, 24);
      const startedAt = typeof payload?.timestamp === "string" ? payload.timestamp : new Date(statSync(path).birthtimeMs).toISOString();
      const sourceKey = path;
      const cursor = this.database.getCursor(this.id, sourceKey);
      const offset = typeof cursor?.offset === "number" ? cursor.offset : 0;
      const chunk = readJsonLines(path, offset);
      const sessionId = this.database.upsertSession({
        projectId: project.projectId,
        agentId: this.id,
        externalId,
        cwd,
        startedAt,
        sourceUri: `codex://session/${externalId}`,
        lastCursor: String(chunk.nextOffset),
      });
      this.database.linkSessionGraph({ projectId: project.projectId, projectName: project.name, agentId: this.id, sessionId, externalId, startedAt });
      for (const line of chunk.lines) {
        const record = line.value;
        if (record.type !== "response_item") continue;
        const item = recordObject(record.payload);
        if (!item || typeof item.type !== "string") continue;
        let kind: EventKind | null = null;
        let summaryText = "";
        let eventPayload: Record<string, unknown> = {};
        if (item.type === "message") {
          const body = extractText(item.content);
          if (!body) continue;
          const role = typeof item.role === "string" ? item.role : "agent";
          const protectedContent = protectedMessage(role, body, privacy);
          kind = "message";
          summaryText = protectedContent.summary;
          eventPayload = { ...protectedContent.payload, phase: item.phase ?? null };
        } else if (item.type === "custom_tool_call") {
          const name = typeof item.name === "string" ? item.name : "unknown";
          kind = name === "apply_patch" ? "file_change" : name === "exec_command" ? "command" : "tool_call";
          summaryText = `Tool: ${name}`;
          eventPayload = { name, input: sanitizeForPolicy(item.input, privacy), callId: item.call_id ?? null };
        } else if (item.type === "custom_tool_call_output") {
          kind = "tool_call";
          const outputLength = typeof item.output === "string" ? item.output.length : JSON.stringify(item.output ?? null).length;
          summaryText = `Tool result (${outputLength} chars)`;
          eventPayload = { callId: item.call_id ?? null, outputLength };
        }
        if (!kind || !summaryText) continue;
        const sourceUri = `codex://session/${externalId}/event/${line.start}`;
        const event = this.database.appendEvent({
          projectId: project.projectId,
          agentId: this.id,
          sessionId,
          kind,
          occurredAt: typeof record.timestamp === "string" ? record.timestamp : startedAt,
          sourceUri,
          sourceOffset: String(line.start),
          dedupeKey: hash(`${this.id}\0${path}\0${line.start}`),
          summary: summaryText,
          payload: eventPayload,
          confidence: 1,
        });
        this.database.addEvidence({ projectId: project.projectId, eventId: event.id, uri: sourceUri, kind: "adapter", locator: { path, byteOffset: line.start } });
        result.ingested += 1;
      }
      this.database.setCursor(this.id, sourceKey, { offset: chunk.nextOffset, size: chunk.size, mtimeMs: chunk.mtimeMs, sessionId: externalId });
      result.cursor = { lastSource: sourceKey, offset: chunk.nextOffset };
    }
    return result;
  }
}
