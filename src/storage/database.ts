import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import BetterSqlite3 from "better-sqlite3";

import type {
  EvidenceInput,
  EntityStatus,
  EventKind,
  GraphEdgeInput,
  GraphNodeInput,
  MemoryEvent,
  MemoryEventInput,
  ProjectIdentity,
  ProjectFact,
  ProjectPrivacyPolicy,
  RepositorySnapshot,
  SearchHit,
  StateInput,
} from "../domain/types.js";
import { MIGRATIONS } from "./migrations.js";

type Row = Record<string, unknown>;

interface CompatibleStatement {
  all(...parameters: unknown[]): Row[];
  get(...parameters: unknown[]): Row | undefined;
  run(...parameters: unknown[]): unknown;
}

interface CompatibleDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): CompatibleStatement;
}

function now(): string {
  return new Date().toISOString();
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError(`Expected string column ${key}`);
  return value;
}

function optionalText(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function number(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new TypeError(`Expected number column ${key}`);
  return value;
}

function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function containsPath(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function eventSearchBoost(kind: string): number {
  const boosts: Record<string, number> = {
    decision: 4,
    state_change: 4,
    issue: 4,
    handoff: 3,
    memory: 2,
    message: 1,
    command: -1,
    tool_call: -2,
  };
  return boosts[kind] ?? 0;
}

function graphOutput(nodeRows: Row[], edgeRows: Row[]) {
  return {
    nodes: nodeRows.map((row) => ({
      id: text(row, "id"), projectId: text(row, "project_id"), type: text(row, "type"), label: text(row, "label"),
      status: text(row, "status"), summary: text(row, "summary"), attributes: parseObject(text(row, "attributes_json")),
      validFrom: text(row, "valid_from"), validTo: optionalText(row, "valid_to"), sourceEventId: optionalText(row, "source_event_id"),
    })),
    edges: edgeRows.map((row) => ({
      id: text(row, "id"), projectId: text(row, "project_id"), source: text(row, "source_node_id"), target: text(row, "target_node_id"),
      type: text(row, "type"), status: text(row, "status"), attributes: parseObject(text(row, "attributes_json")),
      validFrom: text(row, "valid_from"), validTo: optionalText(row, "valid_to"), sourceEventId: optionalText(row, "source_event_id"),
    })),
  };
}

export class MemoryDatabase {
  readonly path: string;
  readonly db: CompatibleDatabase;
  private readonly nativeDb: BetterSqlite3.Database;

  constructor(path: string) {
    this.path = path === ":memory:" ? path : resolve(path);
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
    this.nativeDb = new BetterSqlite3(this.path);
    this.db = this.nativeDb as unknown as CompatibleDatabase;
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  async backup(destination: string): Promise<string> {
    const target = resolve(destination);
    mkdirSync(dirname(target), { recursive: true });
    await this.nativeDb.backup(target);
    return target;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set(
      this.db.prepare("SELECT version FROM schema_migrations").all().map((row) => number(row, "version")),
    );
    MIGRATIONS.forEach((sql, index) => {
      const version = index + 1;
      if (applied.has(version)) return;
      this.transaction(() => {
        this.db.exec(sql);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(version, now());
      });
    });
  }

  ensureWorkspace(name = "My Workspace", id = "workspace_default"): string {
    this.db.prepare("INSERT OR IGNORE INTO workspaces(id, name, created_at) VALUES (?, ?, ?)").run(id, name, now());
    return id;
  }

  createProject(input: { name: string; slug: string; root: string; workspaceId?: string; projectId?: string }): ProjectIdentity {
    const projectId = input.projectId ?? `prj_${randomUUID()}`;
    const workspaceId = input.workspaceId ?? this.ensureWorkspace();
    const createdAt = now();
    const root = resolve(input.root);
    const fingerprint = createHash("sha256").update(root).digest("hex");
    this.transaction(() => {
      this.db.prepare(
        "INSERT INTO projects(id, workspace_id, name, slug, created_at, updated_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(projectId, workspaceId, input.name, input.slug, createdAt, createdAt, createdAt);
      this.db.prepare(
        "INSERT INTO project_roots(project_id, root_path, root_fingerprint, is_primary, created_at) VALUES (?, ?, ?, 1, ?)",
      ).run(projectId, root, fingerprint, createdAt);
    });
    return { projectId, workspaceId, name: input.name, slug: input.slug, primaryRoot: root, createdAt };
  }

  addProjectRoot(projectId: string, root: string, primary = false): void {
    const normalized = resolve(root);
    const existing = this.db.prepare("SELECT project_id FROM project_roots WHERE root_path = ?").get(normalized);
    if (existing && text(existing, "project_id") !== projectId) {
      throw new Error(`${normalized} is already attached to another MemoryGraph project`);
    }
    const fingerprint = createHash("sha256").update(normalized).digest("hex");
    this.transaction(() => {
      if (primary) this.db.prepare("UPDATE project_roots SET is_primary = 0 WHERE project_id = ?").run(projectId);
      this.db.prepare(
        `INSERT INTO project_roots(project_id, root_path, root_fingerprint, is_primary, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(root_path) DO UPDATE SET project_id=excluded.project_id,
           is_primary=CASE WHEN excluded.is_primary=1 THEN 1 ELSE project_roots.is_primary END`,
      ).run(projectId, normalized, fingerprint, primary ? 1 : 0, now());
    });
  }

  upsertSession(input: {
    projectId: string;
    agentId: string;
    externalId: string;
    cwd?: string;
    startedAt: string;
    endedAt?: string;
    sourceUri: string;
    lastCursor?: string;
    summary?: string;
    status?: string;
  }): string {
    const existing = this.db.prepare("SELECT id FROM sessions WHERE agent_id = ? AND external_id = ?").get(input.agentId, input.externalId);
    const id = existing ? text(existing, "id") : `session_${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO sessions(id, project_id, agent_id, external_id, cwd, started_at, ended_at, source_uri, last_cursor, summary, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, external_id) DO UPDATE SET project_id=excluded.project_id, cwd=COALESCE(excluded.cwd, sessions.cwd),
         ended_at=COALESCE(excluded.ended_at, sessions.ended_at), source_uri=excluded.source_uri,
         last_cursor=COALESCE(excluded.last_cursor, sessions.last_cursor), summary=CASE WHEN excluded.summary='' THEN sessions.summary ELSE excluded.summary END,
         status=excluded.status`,
    ).run(
      id,
      input.projectId,
      input.agentId,
      input.externalId,
      input.cwd ?? null,
      input.startedAt,
      input.endedAt ?? null,
      input.sourceUri,
      input.lastCursor ?? null,
      input.summary ?? "",
      input.status ?? "active",
    );
    return id;
  }

  getProject(projectId: string): ProjectIdentity | null {
    const row = this.db.prepare(
      `SELECT p.id, p.workspace_id, p.name, p.slug, p.created_at,
              COALESCE((SELECT root_path FROM project_roots r WHERE r.project_id=p.id ORDER BY is_primary DESC, created_at LIMIT 1), '') AS primary_root
       FROM projects p WHERE p.id = ?`,
    ).get(projectId);
    if (!row) return null;
    return {
      projectId: text(row, "id"),
      workspaceId: text(row, "workspace_id"),
      name: text(row, "name"),
      slug: text(row, "slug"),
      primaryRoot: text(row, "primary_root"),
      createdAt: text(row, "created_at"),
    };
  }

  findProjectForPath(candidate: string): ProjectIdentity | null {
    const normalized = resolve(candidate);
    const rows = this.db.prepare(
      `SELECT p.id, p.workspace_id, p.name, p.slug, p.created_at, r.root_path
       FROM project_roots r JOIN projects p ON p.id=r.project_id
       ORDER BY length(r.root_path) DESC`,
    ).all();
    for (const row of rows) {
      const root = text(row, "root_path");
      if (containsPath(root, normalized)) {
        return {
          projectId: text(row, "id"),
          workspaceId: text(row, "workspace_id"),
          name: text(row, "name"),
          slug: text(row, "slug"),
          primaryRoot: root,
          createdAt: text(row, "created_at"),
        };
      }
    }
    return null;
  }

  getPrivacyPolicy(projectId: string): ProjectPrivacyPolicy {
    const row = this.db.prepare("SELECT * FROM project_privacy_policies WHERE project_id = ?").get(projectId);
    if (!row) {
      return {
        projectId,
        storeMessageContent: true,
        maxMessageChars: 4_000,
        excludedPathPatterns: [".env", "credentials", ".ssh", "secrets"],
        updatedAt: now(),
      };
    }
    const patterns = JSON.parse(text(row, "excluded_paths_json")) as unknown;
    return {
      projectId,
      storeMessageContent: number(row, "store_message_content") === 1,
      maxMessageChars: number(row, "max_message_chars"),
      excludedPathPatterns: Array.isArray(patterns) ? patterns.filter((value): value is string => typeof value === "string") : [],
      updatedAt: text(row, "updated_at"),
    };
  }

  setPrivacyPolicy(input: {
    projectId: string;
    storeMessageContent?: boolean;
    maxMessageChars?: number;
    excludedPathPatterns?: string[];
  }): ProjectPrivacyPolicy {
    const current = this.getPrivacyPolicy(input.projectId);
    const storeMessageContent = input.storeMessageContent ?? current.storeMessageContent;
    const maxMessageChars = Math.max(200, Math.min(input.maxMessageChars ?? current.maxMessageChars, 20_000));
    const excludedPathPatterns = input.excludedPathPatterns ?? current.excludedPathPatterns;
    const updatedAt = now();
    this.db.prepare(
      `INSERT INTO project_privacy_policies(project_id, store_message_content, max_message_chars, excluded_paths_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET store_message_content=excluded.store_message_content,
         max_message_chars=excluded.max_message_chars, excluded_paths_json=excluded.excluded_paths_json, updated_at=excluded.updated_at`,
    ).run(input.projectId, storeMessageContent ? 1 : 0, maxMessageChars, JSON.stringify(excludedPathPatterns), updatedAt);
    return { projectId: input.projectId, storeMessageContent, maxMessageChars, excludedPathPatterns, updatedAt };
  }

  listProjects(): ProjectIdentity[] {
    const rows = this.db.prepare(
      `SELECT p.id, p.workspace_id, p.name, p.slug, p.created_at,
              COALESCE((SELECT root_path FROM project_roots r WHERE r.project_id=p.id ORDER BY is_primary DESC, created_at LIMIT 1), '') AS primary_root
       FROM projects p ORDER BY p.last_active_at DESC`,
    ).all();
    return rows.map((row) => ({
      projectId: text(row, "id"),
      workspaceId: text(row, "workspace_id"),
      name: text(row, "name"),
      slug: text(row, "slug"),
      primaryRoot: text(row, "primary_root"),
      createdAt: text(row, "created_at"),
    }));
  }

  appendEvent(input: MemoryEventInput): MemoryEvent {
    const existing = this.getEventByDedupeKey(input.dedupeKey);
    if (existing) return existing;
    const id = `evt_${randomUUID()}`;
    const occurredAt = input.occurredAt ?? now();
    const ingestedAt = now();
    const payload = input.payload ?? {};
    const confidence = input.confidence ?? 1;
    this.transaction(() => {
      this.db.prepare(
        `INSERT INTO events(id, project_id, agent_id, session_id, kind, occurred_at, ingested_at, source_uri, source_offset, dedupe_key, summary, payload_json, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.projectId,
        input.agentId,
        input.sessionId ?? null,
        input.kind,
        occurredAt,
        ingestedAt,
        input.sourceUri,
        input.sourceOffset ?? null,
        input.dedupeKey,
        input.summary,
        JSON.stringify(payload),
        confidence,
      );
      this.db.prepare("INSERT INTO events_fts(event_id, project_id, summary, payload) VALUES (?, ?, ?, ?)").run(
        id,
        input.projectId,
        input.summary,
        JSON.stringify(payload),
      );
      this.db.prepare("UPDATE projects SET updated_at = ?, last_active_at = ? WHERE id = ?").run(ingestedAt, occurredAt, input.projectId);
    });
    return {
      id,
      projectId: input.projectId,
      agentId: input.agentId,
      sessionId: input.sessionId ?? null,
      kind: input.kind,
      occurredAt,
      ingestedAt,
      sourceUri: input.sourceUri,
      sourceOffset: input.sourceOffset ?? null,
      dedupeKey: input.dedupeKey,
      summary: input.summary,
      payload,
      confidence,
    };
  }

  private getEventByDedupeKey(dedupeKey: string): MemoryEvent | null {
    const row = this.db.prepare("SELECT * FROM events WHERE dedupe_key = ?").get(dedupeKey);
    return row ? this.eventFromRow(row) : null;
  }

  addEvidence(input: EvidenceInput): string {
    const id = `evd_${randomUUID()}`;
    this.db.prepare(
      `INSERT OR IGNORE INTO evidence(id, project_id, event_id, uri, kind, locator_json, captured_at, digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.projectId, input.eventId, input.uri, input.kind, JSON.stringify(input.locator ?? {}), now(), input.digest ?? null);
    return id;
  }

  setState(input: StateInput): string {
    const existing = this.db.prepare(
      "SELECT id FROM state_entries WHERE project_id = ? AND key = ? AND source_event_id = ?",
    ).get(input.projectId, input.key, input.sourceEventId);
    if (existing) return text(existing, "id");
    const id = `state_${randomUUID()}`;
    const validFrom = input.validFrom ?? now();
    const updatedAt = now();
    this.transaction(() => {
      this.db.prepare(
        "UPDATE state_entries SET valid_to = ?, updated_at = ? WHERE project_id = ? AND key = ? AND valid_to IS NULL",
      ).run(validFrom, updatedAt, input.projectId, input.key);
      this.db.prepare(
        `INSERT INTO state_entries(id, project_id, key, value_json, value_text, status, valid_from, valid_to, source_event_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        id,
        input.projectId,
        input.key,
        JSON.stringify(input.value),
        input.valueText,
        input.status ?? "active",
        validFrom,
        input.sourceEventId,
        updatedAt,
      );
    });
    return id;
  }

  addDecision(input: {
    projectId: string;
    title: string;
    rationale: string;
    status?: EntityStatus;
    decidedAt?: string;
    supersedesId?: string;
    eventId: string;
  }): string {
    const existing = this.db.prepare("SELECT id FROM decisions WHERE event_id = ?").get(input.eventId);
    if (existing) return text(existing, "id");
    const id = `dec_${randomUUID()}`;
    this.transaction(() => {
      if (input.supersedesId) {
        this.db.prepare("UPDATE decisions SET status='deprecated' WHERE id=? AND project_id=?").run(input.supersedesId, input.projectId);
      }
      this.db.prepare(
        `INSERT INTO decisions(id, project_id, title, rationale, status, decided_at, supersedes_id, event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.projectId,
        input.title,
        input.rationale,
        input.status ?? "active",
        input.decidedAt ?? now(),
        input.supersedesId ?? null,
        input.eventId,
      );
    });
    return id;
  }

  getDecision(decisionId: string): { id: string; projectId: string; title: string; rationale: string; status: EntityStatus; decidedAt: string; eventId: string } | null {
    const row = this.db.prepare(
      "SELECT id, project_id, title, rationale, status, decided_at, event_id FROM decisions WHERE id=?",
    ).get(decisionId);
    return row ? {
      id: text(row, "id"),
      projectId: text(row, "project_id"),
      title: text(row, "title"),
      rationale: text(row, "rationale"),
      status: text(row, "status") as EntityStatus,
      decidedAt: text(row, "decided_at"),
      eventId: text(row, "event_id"),
    } : null;
  }

  addFact(input: {
    projectId: string;
    subject: string;
    predicate: string;
    objectText: string;
    confidence?: number;
    status?: EntityStatus;
    validFrom?: string;
    sourceEventId: string;
  }): string {
    const existing = this.db.prepare(
      "SELECT id FROM facts WHERE project_id = ? AND subject = ? AND predicate = ? AND source_event_id = ?",
    ).get(input.projectId, input.subject, input.predicate, input.sourceEventId);
    if (existing) return text(existing, "id");
    const id = `fact_${randomUUID()}`;
    const validFrom = input.validFrom ?? now();
    this.transaction(() => {
      this.db.prepare(
        `UPDATE facts SET valid_to = ?
         WHERE project_id = ? AND subject = ? AND predicate = ? AND valid_to IS NULL`,
      ).run(validFrom, input.projectId, input.subject, input.predicate);
      this.db.prepare(
        `INSERT INTO facts(id, project_id, subject, predicate, object_text, confidence, status, valid_from, valid_to, source_event_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        id,
        input.projectId,
        input.subject,
        input.predicate,
        input.objectText,
        input.confidence ?? 1,
        input.status ?? "active",
        validFrom,
        input.sourceEventId,
        now(),
      );
    });
    return id;
  }

  listFacts(projectId: string, limit = 20, includeHistory = false): ProjectFact[] {
    const historyClause = includeHistory ? "" : "AND f.valid_to IS NULL AND f.status != 'deprecated'";
    return this.db.prepare(
      `SELECT f.id, f.project_id, f.subject, f.predicate, f.object_text, f.confidence, f.status, f.valid_from, f.valid_to, f.source_event_id
       FROM facts f JOIN events e ON e.id = f.source_event_id
       WHERE f.project_id = ? ${historyClause} AND e.excluded = 0
       ORDER BY f.valid_from DESC LIMIT ?`,
    ).all(projectId, Math.max(1, Math.min(limit, 100_000))).map((row) => ({
      id: text(row, "id"),
      projectId: text(row, "project_id"),
      subject: text(row, "subject"),
      predicate: text(row, "predicate"),
      objectText: text(row, "object_text"),
      confidence: number(row, "confidence"),
      status: text(row, "status") as EntityStatus,
      validFrom: text(row, "valid_from"),
      validTo: optionalText(row, "valid_to"),
      sourceEventId: text(row, "source_event_id"),
    }));
  }

  upsertNode(input: GraphNodeInput): string {
    const id = input.id ?? `node_${randomUUID()}`;
    const timestamp = now();
    this.transaction(() => {
      this.db.prepare(
        `INSERT INTO nodes(id, project_id, type, label, status, summary, attributes_json, valid_from, valid_to, source_event_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET type=excluded.type, label=excluded.label, status=excluded.status,
           summary=excluded.summary, attributes_json=excluded.attributes_json, valid_from=MIN(nodes.valid_from, excluded.valid_from),
           valid_to=excluded.valid_to, source_event_id=excluded.source_event_id, updated_at=excluded.updated_at`,
      ).run(
        id,
        input.projectId,
        input.type,
        input.label,
        input.status ?? "active",
        input.summary ?? "",
        JSON.stringify(input.attributes ?? {}),
        input.validFrom ?? timestamp,
        input.validTo ?? null,
        input.sourceEventId ?? null,
        timestamp,
        timestamp,
      );
      this.db.prepare("DELETE FROM nodes_fts WHERE node_id = ?").run(id);
      this.db.prepare("INSERT INTO nodes_fts(node_id, project_id, label, summary) VALUES (?, ?, ?, ?)").run(
        id,
        input.projectId,
        input.label,
        input.summary ?? "",
      );
    });
    return id;
  }

  addEdge(input: GraphEdgeInput): string {
    const id = input.id ?? `edge_${randomUUID()}`;
    const timestamp = now();
    this.db.prepare(
      `INSERT INTO edges(id, project_id, source_node_id, target_node_id, type, status, attributes_json, valid_from, valid_to, source_event_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET source_node_id=excluded.source_node_id, target_node_id=excluded.target_node_id,
         type=excluded.type, status=excluded.status, attributes_json=excluded.attributes_json,
         valid_from=excluded.valid_from, valid_to=excluded.valid_to, source_event_id=excluded.source_event_id`,
    ).run(
      id,
      input.projectId,
      input.sourceNodeId,
      input.targetNodeId,
      input.type,
      input.status ?? "active",
      JSON.stringify(input.attributes ?? {}),
      input.validFrom ?? timestamp,
      input.validTo ?? null,
      input.sourceEventId ?? null,
      timestamp,
    );
    return id;
  }

  linkSessionGraph(input: {
    projectId: string;
    projectName: string;
    agentId: string;
    sessionId: string;
    externalId: string;
    title?: string;
    startedAt: string;
  }): void {
    const projectNode = `project:${input.projectId}`;
    const agentNode = `agent:${input.agentId}`;
    const sessionNode = `session:${input.sessionId}`;
    this.upsertNode({ id: projectNode, projectId: input.projectId, type: "Project", label: input.projectName, status: "active", summary: `Project ${input.projectName}`, validFrom: input.startedAt });
    this.upsertNode({ id: agentNode, projectId: input.projectId, type: "Agent", label: input.agentId, status: "active", attributes: { agentId: input.agentId }, validFrom: input.startedAt });
    this.upsertNode({
      id: sessionNode,
      projectId: input.projectId,
      type: "Session",
      label: input.title?.trim() || `${input.agentId} session`,
      status: "complete",
      attributes: { agent: input.agentId, externalId: input.externalId },
      validFrom: input.startedAt,
    });
    this.addEdge({ id: `edge:${projectNode}:${sessionNode}:contains`, projectId: input.projectId, sourceNodeId: projectNode, targetNodeId: sessionNode, type: "CONTAINS", validFrom: input.startedAt });
    this.addEdge({ id: `edge:${sessionNode}:${agentNode}:produced-by`, projectId: input.projectId, sourceNodeId: sessionNode, targetNodeId: agentNode, type: "PRODUCED_BY", validFrom: input.startedAt });
  }

  projectRepositoryGraph(input: {
    project: ProjectIdentity;
    snapshot: RepositorySnapshot;
    agentId: string | null;
    sourceEventId?: string;
  }): void {
    const projectNode = `project:${input.project.projectId}`;
    const currentFileIds = new Set(input.snapshot.changedFiles.slice(0, 200).map((path) => `file:${input.project.projectId}:${createHash("sha256").update(path).digest("hex").slice(0, 24)}`));
    const previouslyDirty = this.db.prepare(
      "SELECT id FROM nodes WHERE project_id=? AND type='File' AND valid_to IS NULL AND json_extract(attributes_json, '$.uncommitted')=1",
    ).all(input.project.projectId);
    for (const row of previouslyDirty) {
      const id = text(row, "id");
      if (currentFileIds.has(id)) continue;
      this.db.prepare("UPDATE nodes SET status='complete', valid_to=?, updated_at=? WHERE id=?").run(input.snapshot.capturedAt, now(), id);
      this.db.prepare("UPDATE edges SET valid_to=? WHERE valid_to IS NULL AND (source_node_id=? OR target_node_id=?)").run(input.snapshot.capturedAt, id, id);
    }
    if (input.snapshot.head) {
      const commitNode = `commit:${input.project.projectId}:${input.snapshot.head}`;
      this.upsertNode({
        id: commitNode,
        projectId: input.project.projectId,
        type: "Commit",
        label: input.snapshot.head.slice(0, 10),
        status: "complete",
        summary: input.snapshot.branch ? `HEAD on ${input.snapshot.branch}` : "Repository HEAD",
        attributes: { hash: input.snapshot.head, branch: input.snapshot.branch },
        validFrom: input.snapshot.capturedAt,
        ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
      });
      this.addEdge({ id: `edge:${projectNode}:${commitNode}:contains`, projectId: input.project.projectId, sourceNodeId: projectNode, targetNodeId: commitNode, type: "CONTAINS", validFrom: input.snapshot.capturedAt, ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}) });
    }
    for (const path of input.snapshot.changedFiles.slice(0, 200)) {
      const fileId = `file:${input.project.projectId}:${createHash("sha256").update(path).digest("hex").slice(0, 24)}`;
      this.upsertNode({
        id: fileId,
        projectId: input.project.projectId,
        type: "File",
        label: path,
        status: "active",
        summary: "Uncommitted repository change",
        attributes: { path, uncommitted: true },
        validFrom: input.snapshot.capturedAt,
        ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
      });
      this.addEdge({ id: `edge:${projectNode}:${fileId}:contains`, projectId: input.project.projectId, sourceNodeId: projectNode, targetNodeId: fileId, type: "CONTAINS", validFrom: input.snapshot.capturedAt, ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}) });
      if (input.agentId) {
        const agentNode = `agent:${input.agentId}`;
        this.upsertNode({ id: agentNode, projectId: input.project.projectId, type: "Agent", label: input.agentId, status: "active", attributes: { agentId: input.agentId }, validFrom: input.snapshot.capturedAt });
        this.addEdge({ id: `edge:${fileId}:${agentNode}:modified-by`, projectId: input.project.projectId, sourceNodeId: fileId, targetNodeId: agentNode, type: "MODIFIED_BY", validFrom: input.snapshot.capturedAt, ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}) });
      }
    }
  }

  currentState(projectId: string, limit = 50): Array<{
    key: string;
    value: unknown;
    valueText: string;
    status: EntityStatus;
    validFrom: string;
    sourceEventId: string;
  }> {
    return this.db.prepare(
      `SELECT s.key, s.value_json, s.value_text, s.status, s.valid_from, s.source_event_id
       FROM state_entries s JOIN events e ON e.id = s.source_event_id
       WHERE s.project_id = ? AND s.valid_to IS NULL AND e.excluded = 0
       ORDER BY s.updated_at DESC LIMIT ?`,
    ).all(projectId, limit).map((row) => ({
      key: text(row, "key"),
      value: JSON.parse(text(row, "value_json")) as unknown,
      valueText: text(row, "value_text"),
      status: text(row, "status") as EntityStatus,
      validFrom: text(row, "valid_from"),
      sourceEventId: text(row, "source_event_id"),
    }));
  }

  activeNodes(projectId: string, limit = 50): Array<{ id: string; type: string; label: string; status: EntityStatus; summary: string }> {
    return this.db.prepare(
      `SELECT n.id, n.type, n.label, n.status, n.summary FROM nodes n
       LEFT JOIN events e ON e.id = n.source_event_id
       WHERE n.project_id = ? AND n.valid_to IS NULL AND n.status IN ('active', 'blocked', 'planned')
         AND (n.source_event_id IS NULL OR e.excluded = 0)
       ORDER BY CASE n.status WHEN 'blocked' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, n.updated_at DESC LIMIT ?`,
    ).all(projectId, limit).map((row) => ({
      id: text(row, "id"),
      type: text(row, "type"),
      label: text(row, "label"),
      status: text(row, "status") as EntityStatus,
      summary: text(row, "summary"),
    }));
  }

  recentDecisions(projectId: string, limit = 8): Array<{ id: string; title: string; rationale: string; decidedAt: string }> {
    return this.db.prepare(
      `SELECT d.id, d.title, d.rationale, d.decided_at FROM decisions d
       JOIN events e ON e.id = d.event_id
       WHERE d.project_id = ? AND d.status != 'deprecated' AND e.excluded = 0 ORDER BY d.decided_at DESC LIMIT ?`,
    ).all(projectId, limit).map((row) => ({
      id: text(row, "id"),
      title: text(row, "title"),
      rationale: text(row, "rationale"),
      decidedAt: text(row, "decided_at"),
    }));
  }

  recentEvents(projectId: string, limit = 20): Array<{
    id: string;
    agentId: string;
    kind: EventKind;
    summary: string;
    occurredAt: string;
    sourceUri: string;
  }> {
    return this.db.prepare(
      `SELECT id, agent_id, kind, summary, occurred_at, source_uri
       FROM events WHERE project_id = ? AND excluded = 0 ORDER BY occurred_at DESC LIMIT ?`,
    ).all(projectId, limit).map((row) => ({
      id: text(row, "id"),
      agentId: text(row, "agent_id"),
      kind: text(row, "kind") as EventKind,
      summary: text(row, "summary"),
      occurredAt: text(row, "occurred_at"),
      sourceUri: text(row, "source_uri"),
    }));
  }

  allEvents(projectId: string): MemoryEvent[] {
    return this.db.prepare("SELECT * FROM events WHERE project_id = ? AND excluded = 0 ORDER BY occurred_at, ingested_at, id").all(projectId).map((row) => this.eventFromRow(row));
  }

  excludeEventsByEvidencePath(path: string, reason: string): number {
    const result = this.db.prepare(
      `UPDATE events SET excluded = 1, excluded_reason = ?
       WHERE id IN (SELECT event_id FROM evidence WHERE json_extract(locator_json, '$.path') = ?)
         AND excluded = 0`,
    ).run(reason, path) as { changes?: number };
    return result.changes ?? 0;
  }

  excludeEventsByRoles(projectId: string, agentId: string, roles: string[], reason: string): number {
    if (roles.length === 0) return 0;
    const placeholders = roles.map(() => "?").join(",");
    const result = this.db.prepare(
      `UPDATE events SET excluded=1, excluded_reason=?
       WHERE project_id=? AND agent_id=? AND kind='message' AND excluded=0
         AND json_extract(payload_json, '$.role') IN (${placeholders})`,
    ).run(reason, projectId, agentId, ...roles) as { changes?: number };
    return result.changes ?? 0;
  }

  listSessions(projectId: string): Array<{
    id: string;
    agentId: string;
    externalId: string;
    cwd: string | null;
    startedAt: string;
    endedAt: string | null;
    sourceUri: string;
    summary: string;
    status: string;
  }> {
    return this.db.prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at").all(projectId).map((row) => ({
      id: text(row, "id"),
      agentId: text(row, "agent_id"),
      externalId: text(row, "external_id"),
      cwd: optionalText(row, "cwd"),
      startedAt: text(row, "started_at"),
      endedAt: optionalText(row, "ended_at"),
      sourceUri: text(row, "source_uri"),
      summary: text(row, "summary"),
      status: text(row, "status"),
    }));
  }

  clearProjectGraph(projectId: string): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM edges WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM nodes_fts WHERE node_id IN (SELECT id FROM nodes WHERE project_id = ? AND type != 'Project')").run(projectId);
      this.db.prepare("DELETE FROM nodes WHERE project_id = ? AND type != 'Project'").run(projectId);
    });
  }

  listHandoffs(projectId: string, limit = 100): Array<Record<string, unknown>> {
    return this.db.prepare(
      `SELECT id, previous_agent, receiving_agent, created_at, context_json, inherited_event_ids_json,
              estimated_tokens, outcome_status, outcome_summary, completed_at
       FROM handoffs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`,
    ).all(projectId, Math.max(1, Math.min(limit, 100_000))).map((row) => ({
      id: text(row, "id"),
      previousAgent: optionalText(row, "previous_agent"),
      receivingAgent: text(row, "receiving_agent"),
      createdAt: text(row, "created_at"),
      context: parseObject(text(row, "context_json")),
      inheritedEventIds: JSON.parse(text(row, "inherited_event_ids_json")) as unknown,
      estimatedTokens: number(row, "estimated_tokens"),
      outcomeStatus: text(row, "outcome_status"),
      outcomeSummary: optionalText(row, "outcome_summary"),
      completedAt: optionalText(row, "completed_at"),
    }));
  }

  stateHistory(projectId: string, limit = 500): Array<Record<string, unknown>> {
    return this.db.prepare(
      `SELECT s.id, s.key, s.value_json, s.value_text, s.status, s.valid_from, s.valid_to, s.source_event_id
       FROM state_entries s JOIN events e ON e.id = s.source_event_id
       WHERE s.project_id = ? AND e.excluded = 0 ORDER BY s.valid_from DESC LIMIT ?`,
    ).all(projectId, Math.max(1, Math.min(limit, 100_000))).map((row) => ({
      id: text(row, "id"),
      key: text(row, "key"),
      value: JSON.parse(text(row, "value_json")) as unknown,
      valueText: text(row, "value_text"),
      status: text(row, "status"),
      validFrom: text(row, "valid_from"),
      validTo: optionalText(row, "valid_to"),
      sourceEventId: text(row, "source_event_id"),
    }));
  }

  stateAt(projectId: string, at: string): Array<{
    key: string;
    value: unknown;
    valueText: string;
    status: EntityStatus;
    validFrom: string;
    validTo: string | null;
    sourceEventId: string;
  }> {
    return this.db.prepare(
      `SELECT s.key, s.value_json, s.value_text, s.status, s.valid_from, s.valid_to, s.source_event_id
       FROM state_entries s JOIN events e ON e.id = s.source_event_id
       WHERE s.project_id = ? AND s.valid_from <= ? AND (s.valid_to IS NULL OR s.valid_to > ?) AND e.excluded = 0
       ORDER BY s.key`,
    ).all(projectId, at, at).map((row) => ({
      key: text(row, "key"),
      value: JSON.parse(text(row, "value_json")) as unknown,
      valueText: text(row, "value_text"),
      status: text(row, "status") as EntityStatus,
      validFrom: text(row, "valid_from"),
      validTo: optionalText(row, "valid_to"),
      sourceEventId: text(row, "source_event_id"),
    }));
  }

  diffState(projectId: string, from: string, to: string): {
    from: string;
    to: string;
    added: ReturnType<MemoryDatabase["stateAt"]>;
    removed: ReturnType<MemoryDatabase["stateAt"]>;
    changed: Array<{ key: string; before: ReturnType<MemoryDatabase["stateAt"]>[number]; after: ReturnType<MemoryDatabase["stateAt"]>[number] }>;
  } {
    const before = this.stateAt(projectId, from);
    const after = this.stateAt(projectId, to);
    const beforeByKey = new Map(before.map((entry) => [entry.key, entry]));
    const afterByKey = new Map(after.map((entry) => [entry.key, entry]));
    const added = after.filter((entry) => !beforeByKey.has(entry.key));
    const removed = before.filter((entry) => !afterByKey.has(entry.key));
    const changed = after.flatMap((entry) => {
      const previous = beforeByKey.get(entry.key);
      return previous && JSON.stringify(previous.value) !== JSON.stringify(entry.value) ? [{ key: entry.key, before: previous, after: entry }] : [];
    });
    return { from, to, added, removed, changed };
  }

  nodeEvidence(nodeId: string): Array<Record<string, unknown>> {
    return this.db.prepare(
      `SELECT evd.id, evd.uri, evd.kind, evd.locator_json, evd.captured_at, evd.digest,
              e.id AS event_id, e.agent_id, e.kind AS event_kind, e.summary, e.occurred_at
       FROM nodes n
       JOIN events e ON e.id = n.source_event_id
       LEFT JOIN evidence evd ON evd.event_id = e.id
       WHERE n.id = ? AND e.excluded = 0 ORDER BY evd.captured_at DESC`,
    ).all(nodeId).map((row) => ({
      id: optionalText(row, "id"),
      uri: optionalText(row, "uri"),
      kind: optionalText(row, "kind"),
      locator: optionalText(row, "locator_json") ? parseObject(text(row, "locator_json")) : {},
      capturedAt: optionalText(row, "captured_at"),
      digest: optionalText(row, "digest"),
      event: {
        id: text(row, "event_id"),
        agentId: text(row, "agent_id"),
        kind: text(row, "event_kind"),
        summary: text(row, "summary"),
        occurredAt: text(row, "occurred_at"),
      },
    }));
  }

  previousAgent(projectId: string, excludingAgent: string): string | null {
    const row = this.db.prepare(
      `SELECT agent_id FROM events WHERE project_id = ? AND agent_id != ? AND kind != 'handoff' AND excluded = 0 ORDER BY occurred_at DESC LIMIT 1`,
    ).get(projectId, excludingAgent);
    return row ? text(row, "agent_id") : null;
  }

  search(projectId: string, query: string, limit = 20): SearchHit[] {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const ftsQuery = query.trim().split(/\s+/u).filter(Boolean).map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    if (!ftsQuery) return [];
    const eventHits = this.db.prepare(
      `SELECT e.id, e.kind, e.summary, e.occurred_at, e.source_uri,
              snippet(events_fts, 2, '[', ']', ' … ', 16) AS snippet,
              bm25(events_fts) AS rank
       FROM events_fts JOIN events e ON e.id = events_fts.event_id
       WHERE events_fts MATCH ? AND events_fts.project_id = ? AND e.excluded = 0
       ORDER BY rank LIMIT ?`,
    ).all(ftsQuery, projectId, safeLimit);
    const nodeHits = this.db.prepare(
      `SELECT n.id, n.type, n.label, n.summary, n.updated_at,
              snippet(nodes_fts, 2, '[', ']', ' … ', 16) AS snippet,
              bm25(nodes_fts) AS rank
       FROM nodes_fts JOIN nodes n ON n.id = nodes_fts.node_id
       LEFT JOIN events e ON e.id = n.source_event_id
       WHERE nodes_fts MATCH ? AND nodes_fts.project_id = ? AND n.valid_to IS NULL AND (n.source_event_id IS NULL OR e.excluded = 0)
       ORDER BY rank LIMIT ?`,
    ).all(ftsQuery, projectId, safeLimit);
    return [
      ...eventHits.map((row): SearchHit => ({
        id: text(row, "id"),
        kind: "event",
        title: `${text(row, "kind")}: ${text(row, "summary")}`,
        snippet: text(row, "snippet"),
        score: -number(row, "rank") + eventSearchBoost(text(row, "kind")),
        occurredAt: text(row, "occurred_at"),
        sourceUri: text(row, "source_uri"),
      })),
      ...nodeHits.map((row): SearchHit => ({
        id: text(row, "id"),
        kind: "node",
        title: `${text(row, "type")}: ${text(row, "label")}`,
        snippet: text(row, "snippet") || text(row, "summary"),
        score: -number(row, "rank") + 5,
        occurredAt: text(row, "updated_at"),
      })),
    ].sort((a, b) => b.score - a.score).slice(0, safeLimit);
  }

  createHandoff(input: {
    projectId: string;
    previousAgent: string | null;
    receivingAgent: string;
    context: Record<string, unknown>;
    inheritedEventIds: string[];
    estimatedTokens: number;
  }): string {
    const id = `handoff_${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO handoffs(id, project_id, previous_agent, receiving_agent, created_at, context_json, inherited_event_ids_json, estimated_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.projectId,
      input.previousAgent,
      input.receivingAgent,
      now(),
      JSON.stringify(input.context),
      JSON.stringify(input.inheritedEventIds),
      input.estimatedTokens,
    );
    return id;
  }

  recordHandoffGraph(input: {
    handoffId: string;
    projectId: string;
    projectName: string;
    previousAgent: string | null;
    receivingAgent: string;
    createdAt: string;
    sourceEventId?: string;
    status?: EntityStatus;
  }): void {
    const projectNode = `project:${input.projectId}`;
    const handoffNode = input.handoffId;
    const receivingNode = `agent:${input.receivingAgent}`;
    this.upsertNode({ id: projectNode, projectId: input.projectId, type: "Project", label: input.projectName, status: "active", summary: `Project ${input.projectName}`, validFrom: input.createdAt });
    this.upsertNode({ id: receivingNode, projectId: input.projectId, type: "Agent", label: input.receivingAgent, status: "active", attributes: { agentId: input.receivingAgent }, validFrom: input.createdAt });
    this.upsertNode({ id: handoffNode, projectId: input.projectId, type: "Handoff", label: `${input.previousAgent ?? "project"} → ${input.receivingAgent}`, status: input.status ?? "active", summary: "Pull-based project handoff", attributes: { previousAgent: input.previousAgent, receivingAgent: input.receivingAgent }, validFrom: input.createdAt, ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}) });
    this.addEdge({ id: `edge:${projectNode}:${handoffNode}:contains`, projectId: input.projectId, sourceNodeId: projectNode, targetNodeId: handoffNode, type: "CONTAINS", validFrom: input.createdAt, ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}) });
    this.addEdge({ id: `edge:${handoffNode}:${receivingNode}:continues`, projectId: input.projectId, sourceNodeId: handoffNode, targetNodeId: receivingNode, type: "CONTINUES", validFrom: input.createdAt, ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}) });
    if (input.previousAgent) {
      const previousNode = `agent:${input.previousAgent}`;
      this.upsertNode({ id: previousNode, projectId: input.projectId, type: "Agent", label: input.previousAgent, status: "active", attributes: { agentId: input.previousAgent }, validFrom: input.createdAt });
      this.addEdge({ id: `edge:${previousNode}:${handoffNode}:produced-by`, projectId: input.projectId, sourceNodeId: previousNode, targetNodeId: handoffNode, type: "PRODUCED_BY", validFrom: input.createdAt, ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}) });
    }
  }

  updateHandoffOutcomes(projectId: string): number {
    const pending = this.db.prepare(
      "SELECT id, receiving_agent, created_at FROM handoffs WHERE project_id = ? AND outcome_status = 'pending' ORDER BY created_at",
    ).all(projectId);
    let updated = 0;
    for (const row of pending) {
      const events = this.db.prepare(
        `SELECT summary, occurred_at FROM events
         WHERE project_id = ? AND agent_id = ? AND kind != 'handoff' AND excluded = 0 AND occurred_at > ?
         ORDER BY occurred_at LIMIT 50`,
      ).all(projectId, text(row, "receiving_agent"), text(row, "created_at"));
      if (events.length === 0) continue;
      const last = events[events.length - 1]!;
      this.db.prepare(
        `UPDATE handoffs SET outcome_status = 'continued', outcome_summary = ?, completed_at = ? WHERE id = ?`,
      ).run(
        `${text(row, "receiving_agent")} produced ${events.length} evidence-backed event(s) after receiving the handoff. Latest: ${text(last, "summary")}`,
        text(last, "occurred_at"),
        text(row, "id"),
      );
      this.db.prepare("UPDATE nodes SET status='complete', updated_at=? WHERE id=?").run(now(), text(row, "id"));
      updated += 1;
    }
    return updated;
  }

  graph(projectId?: string): { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> } {
    const nodeRows = projectId
      ? this.db.prepare("SELECT n.* FROM nodes n LEFT JOIN events e ON e.id=n.source_event_id WHERE n.project_id = ? AND n.valid_to IS NULL AND (n.source_event_id IS NULL OR e.excluded = 0)").all(projectId)
      : this.db.prepare("SELECT n.* FROM nodes n LEFT JOIN events e ON e.id=n.source_event_id WHERE n.valid_to IS NULL AND (n.source_event_id IS NULL OR e.excluded = 0)").all();
    const edgeRows = projectId
      ? this.db.prepare("SELECT r.* FROM edges r LEFT JOIN events e ON e.id=r.source_event_id WHERE r.project_id = ? AND r.valid_to IS NULL AND (r.source_event_id IS NULL OR e.excluded = 0)").all(projectId)
      : this.db.prepare("SELECT r.* FROM edges r LEFT JOIN events e ON e.id=r.source_event_id WHERE r.valid_to IS NULL AND (r.source_event_id IS NULL OR e.excluded = 0)").all();
    return graphOutput(nodeRows, edgeRows);
  }

  atlasGraph(): { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>>; totalNodes: number; totalEdges: number; truncated: false } {
    const nodeRows = this.db.prepare(
      `SELECT n.* FROM nodes n LEFT JOIN events e ON e.id=n.source_event_id
       WHERE n.type='Project' AND n.valid_to IS NULL AND (n.source_event_id IS NULL OR e.excluded=0)
       ORDER BY n.updated_at DESC`,
    ).all();
    const edgeRows = this.db.prepare(
      `SELECT r.* FROM edges r
       JOIN nodes source ON source.id=r.source_node_id AND source.type='Project'
       JOIN nodes target ON target.id=r.target_node_id AND target.type='Project'
       LEFT JOIN events e ON e.id=r.source_event_id
       WHERE r.valid_to IS NULL AND (r.source_event_id IS NULL OR e.excluded=0)`,
    ).all();
    const graph = graphOutput(nodeRows, edgeRows);
    return { ...graph, totalNodes: graph.nodes.length, totalEdges: graph.edges.length, truncated: false };
  }

  graphSlice(projectId: string, limit = 2_500): { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>>; totalNodes: number; totalEdges: number; truncated: boolean } {
    const safeLimit = Math.max(100, Math.min(limit, 5_000));
    const selection = `SELECT n.id FROM nodes n LEFT JOIN events ne ON ne.id=n.source_event_id
      WHERE n.project_id=? AND n.valid_to IS NULL AND (n.source_event_id IS NULL OR ne.excluded=0)
      ORDER BY CASE n.type WHEN 'Project' THEN 0 WHEN 'Issue' THEN 1 WHEN 'Task' THEN 2 ELSE 3 END,
               CASE n.status WHEN 'blocked' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, n.updated_at DESC LIMIT ?`;
    const nodeRows = this.db.prepare(
      `WITH selected AS (${selection})
       SELECT n.* FROM nodes n JOIN selected s ON s.id=n.id`,
    ).all(projectId, safeLimit);
    const edgeRows = this.db.prepare(
      `WITH selected AS (${selection})
       SELECT r.* FROM edges r
       JOIN selected source ON source.id=r.source_node_id
       JOIN selected target ON target.id=r.target_node_id
       LEFT JOIN events e ON e.id=r.source_event_id
       WHERE r.project_id=? AND r.valid_to IS NULL AND (r.source_event_id IS NULL OR e.excluded=0)`,
    ).all(projectId, safeLimit, projectId);
    const totalNodeRow = this.db.prepare(
      "SELECT count(*) AS count FROM nodes n LEFT JOIN events e ON e.id=n.source_event_id WHERE n.project_id=? AND n.valid_to IS NULL AND (n.source_event_id IS NULL OR e.excluded=0)",
    ).get(projectId);
    const totalEdgeRow = this.db.prepare(
      "SELECT count(*) AS count FROM edges r LEFT JOIN events e ON e.id=r.source_event_id WHERE r.project_id=? AND r.valid_to IS NULL AND (r.source_event_id IS NULL OR e.excluded=0)",
    ).get(projectId);
    const graph = graphOutput(nodeRows, edgeRows);
    const totalNodes = totalNodeRow ? number(totalNodeRow, "count") : 0;
    const totalEdges = totalEdgeRow ? number(totalEdgeRow, "count") : 0;
    return { ...graph, totalNodes, totalEdges, truncated: totalNodes > graph.nodes.length };
  }

  nodeNeighborhood(nodeId: string, limit = 200): { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>>; totalNodes: number; totalEdges: number; truncated: boolean } | null {
    const safeLimit = Math.max(10, Math.min(limit, 500));
    const center = this.db.prepare(
      `SELECT n.* FROM nodes n LEFT JOIN events e ON e.id=n.source_event_id
       WHERE n.id=? AND n.valid_to IS NULL AND (n.source_event_id IS NULL OR e.excluded=0)`,
    ).get(nodeId);
    if (!center) return null;
    const allIncident = this.db.prepare(
      `SELECT r.* FROM edges r LEFT JOIN events e ON e.id=r.source_event_id
       WHERE (r.source_node_id=? OR r.target_node_id=?) AND r.valid_to IS NULL
         AND (r.source_event_id IS NULL OR e.excluded=0)
       ORDER BY r.created_at DESC`,
    ).all(nodeId, nodeId);
    const edgeRows = allIncident.slice(0, safeLimit);
    const nodeIds = [...new Set([nodeId, ...edgeRows.flatMap((row) => [text(row, "source_node_id"), text(row, "target_node_id")])])];
    const placeholders = nodeIds.map(() => "?").join(",");
    const nodeRows = this.db.prepare(
      `SELECT n.* FROM nodes n LEFT JOIN events e ON e.id=n.source_event_id
       WHERE n.id IN (${placeholders}) AND n.valid_to IS NULL AND (n.source_event_id IS NULL OR e.excluded=0)`,
    ).all(...nodeIds);
    const graph = graphOutput(nodeRows, edgeRows);
    return { ...graph, totalNodes: nodeIds.length, totalEdges: allIncident.length, truncated: allIncident.length > edgeRows.length };
  }

  exportProject(projectId: string): Record<string, unknown> {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const evidence = this.db.prepare(
      `SELECT evd.id, evd.event_id, evd.uri, evd.kind, evd.locator_json, evd.captured_at, evd.digest
       FROM evidence evd JOIN events e ON e.id = evd.event_id
       WHERE evd.project_id = ? AND e.excluded = 0 ORDER BY evd.captured_at, evd.id`,
    ).all(projectId).map((row) => ({
      id: text(row, "id"),
      eventId: text(row, "event_id"),
      uri: text(row, "uri"),
      kind: text(row, "kind"),
      locator: parseObject(text(row, "locator_json")),
      capturedAt: text(row, "captured_at"),
      digest: optionalText(row, "digest"),
    }));
    return {
      schemaVersion: 1,
      exportedAt: now(),
      project,
      privacy: this.getPrivacyPolicy(projectId),
      sessions: this.listSessions(projectId),
      events: this.allEvents(projectId),
      evidence,
      stateHistory: this.stateHistory(projectId, 100_000),
      facts: this.listFacts(projectId, 100_000, true),
      decisions: this.recentDecisions(projectId, 100_000),
      handoffs: this.listHandoffs(projectId, 100_000),
      graph: this.graph(projectId),
    };
  }

  getCursor(adapterId: string, sourceKey: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT cursor_json FROM sync_cursors WHERE adapter_id = ? AND source_key = ?").get(adapterId, sourceKey);
    return row ? parseObject(text(row, "cursor_json")) : null;
  }

  setCursor(adapterId: string, sourceKey: string, cursor: Record<string, unknown>, error?: string): void {
    this.db.prepare(
      `INSERT INTO sync_cursors(adapter_id, source_key, cursor_json, updated_at, error) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(adapter_id, source_key) DO UPDATE SET cursor_json=excluded.cursor_json, updated_at=excluded.updated_at, error=excluded.error`,
    ).run(adapterId, sourceKey, JSON.stringify(cursor), now(), error ?? null);
  }

  private eventFromRow(row: Row): MemoryEvent {
    return {
      id: text(row, "id"),
      projectId: text(row, "project_id"),
      agentId: text(row, "agent_id"),
      sessionId: optionalText(row, "session_id"),
      kind: text(row, "kind") as EventKind,
      occurredAt: text(row, "occurred_at"),
      ingestedAt: text(row, "ingested_at"),
      sourceUri: text(row, "source_uri"),
      sourceOffset: optionalText(row, "source_offset"),
      dedupeKey: text(row, "dedupe_key"),
      summary: text(row, "summary"),
      payload: parseObject(text(row, "payload_json")),
      confidence: number(row, "confidence"),
    };
  }
}
