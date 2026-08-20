import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { CodexAdapter } from "../src/adapters/codex-adapter.js";
import { fileContainsText, readJsonLines } from "../src/adapters/jsonl.js";
import { CommandCodeAdapter } from "../src/adapters/command-code-adapter.js";
import { OpenCodeAdapter } from "../src/adapters/opencode-adapter.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { TraeAdapter } from "../src/adapters/trae-adapter.js";
import { WorkBuddyAdapter } from "../src/adapters/workbuddy-adapter.js";
import { MemoryGraphCore } from "../src/core/memorygraph-core.js";
import { MemoryDatabase } from "../src/storage/database.js";

const cleanup: string[] = [];

function temporary(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("agent adapters", () => {
  it("keeps an incomplete JSONL tail for the next incremental read", () => {
    const root = temporary("memorygraph-jsonl-tail-");
    const path = join(root, "events.jsonl");
    writeFileSync(path, '{"type":"complete"}\n{"type":"partial"');
    const first = readJsonLines(path, 0);
    expect(first.lines.map((line) => line.value.type)).toEqual(["complete"]);
    expect(first.nextOffset).toBe(Buffer.byteLength('{"type":"complete"}\n'));
    const boundaryPath = join(root, "boundary.log");
    writeFileSync(boundaryPath, `${"x".repeat(65_533)}跨边界项目路径`);
    expect(fileContainsText(boundaryPath, "跨边界项目路径")).toBe(true);
  });

  it("ingests Codex JSONL incrementally and strips tool secrets", () => {
    const projectRoot = temporary("memorygraph-adapter-project-");
    const sessionsRoot = temporary("memorygraph-codex-source-");
    const database = new MemoryDatabase(join(temporary("memorygraph-adapter-data-"), "memorygraph.db"));
    const project = new MemoryGraphCore(database).resolveProject(projectRoot, true, "Adapter Project");
    const dateDirectory = join(sessionsRoot, "2026", "08", "20");
    mkdirSync(dateDirectory, { recursive: true });
    const source = join(dateDirectory, "rollout-test.jsonl");
    const records = [
      { timestamp: "2026-08-20T10:00:00.000Z", type: "session_meta", payload: { cwd: projectRoot, id: "codex-session", session_id: "codex-session", thread_source: "user", timestamp: "2026-08-20T10:00:00.000Z" } },
      { timestamp: "2026-08-20T10:01:00.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Implemented the event store." }] } },
      { timestamp: "2026-08-20T10:01:30.000Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "Internal control instructions" }] } },
      { timestamp: "2026-08-20T10:02:00.000Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec_command", call_id: "call-1", input: { cmd: "cat .env", authorization_token: "secret-value" } } },
    ];
    writeFileSync(source, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    writeFileSync(join(dateDirectory, "rollout-subagent.jsonl"), `${[
      { timestamp: "2026-08-20T10:00:00.000Z", type: "session_meta", payload: { cwd: projectRoot, id: "guardian-session", session_id: "codex-session", thread_source: "subagent", source: { subagent: { other: "guardian" } } } },
      { timestamp: "2026-08-20T10:03:00.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "{\"risk_level\":\"low\"}" }] } },
    ].map((record) => JSON.stringify(record)).join("\n")}\n`);

    database.setPrivacyPolicy({ projectId: project.projectId, storeMessageContent: false, excludedPathPatterns: [".env"] });
    const adapter = new CodexAdapter(database, sessionsRoot);
    expect(adapter.sync(project).ingested).toBe(2);
    expect(adapter.sync(project).ingested).toBe(0);
    const events = database.recentEvents(project.projectId, 10);
    expect(events.some((event) => event.summary.includes("risk_level"))).toBe(false);
    expect(events.some((event) => event.summary.includes("Internal control instructions"))).toBe(false);
    expect(events.map((event) => event.kind)).toContain("command");
    const stored = database.db.prepare("SELECT payload_json FROM events WHERE kind='command'").get() as Record<string, unknown>;
    expect(String(stored.payload_json)).toContain("[REDACTED]");
    expect(String(stored.payload_json)).toContain("[EXCLUDED_BY_PROJECT_POLICY]");
    expect(String(stored.payload_json)).not.toContain("secret-value");
    expect(events.find((event) => event.kind === "message")?.summary).toContain("content excluded");
    const projected = new MemoryGraphCore(database, new AdapterRegistry([adapter])).syncProject(projectRoot);
    expect(projected.projectedAgents).toEqual(["codex"]);
    expect(database.currentState(project.projectId).some((entry) => entry.key === "agent.codex.last_activity")).toBe(true);
    database.close();
  });

  it("ingests OpenCode SQLite parts with a durable timestamp cursor", () => {
    const projectRoot = temporary("memorygraph-opencode-project-");
    const dataRoot = temporary("memorygraph-opencode-data-");
    const sourcePath = join(dataRoot, "opencode.db");
    const source = new BetterSqlite3(sourcePath);
    source.exec(`
      CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER);
    `);
    const timestamp = Date.parse("2026-08-20T10:00:00.000Z");
    source.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?)").run("ses_1", projectRoot, "OpenCode task", timestamp, timestamp + 2);
    source.prepare("INSERT INTO message VALUES (?, ?, ?)").run("msg_1", "ses_1", JSON.stringify({ role: "assistant" }));
    source.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run("part_1", "msg_1", JSON.stringify({ type: "text", text: "The adapter is ready." }), timestamp + 1, timestamp + 1);
    source.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run("part_2", "msg_1", JSON.stringify({ type: "tool", tool: "bash", state: { input: "npm test" } }), timestamp + 2, timestamp + 2);
    source.close();

    const database = new MemoryDatabase(join(temporary("memorygraph-opencode-store-"), "memorygraph.db"));
    const project = new MemoryGraphCore(database).resolveProject(projectRoot, true, "OpenCode Project");
    const adapter = new OpenCodeAdapter(database, sourcePath);
    expect(adapter.sync(project).ingested).toBe(2);
    expect(adapter.sync(project).ingested).toBe(0);
    expect(database.recentEvents(project.projectId, 10).some((event) => event.agentId === "opencode")).toBe(true);
    database.close();
  });

  it("ingests Command Code message parts incrementally", () => {
    const projectRoot = temporary("memorygraph-command-project-");
    const projectsRoot = temporary("memorygraph-command-source-");
    const directory = join(projectsRoot, "project-key");
    mkdirSync(directory, { recursive: true });
    const source = join(directory, "session.jsonl");
    const records = [
      { type: "session", id: "command-session", cwd: projectRoot, timestamp: "2026-08-20T10:00:00.000Z", version: 3 },
      { type: "message", timestamp: "2026-08-20T10:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "Continued the project." }, { type: "tool_use", id: "tool-1", name: "shell", input: { command: "git status" } }] } },
    ];
    writeFileSync(source, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const database = new MemoryDatabase(join(temporary("memorygraph-command-store-"), "memorygraph.db"));
    const project = new MemoryGraphCore(database).resolveProject(projectRoot, true, "Command Project");
    const adapter = new CommandCodeAdapter(database, projectsRoot);
    expect(adapter.sync(project).ingested).toBe(2);
    expect(adapter.sync(project).ingested).toBe(0);
    database.close();
  });

  it("ingests WorkBuddy native JSONL records incrementally", () => {
    const projectRoot = temporary("memorygraph-workbuddy-project-");
    const workbuddyRoot = temporary("memorygraph-workbuddy-source-");
    const directory = join(workbuddyRoot, "projects", "project-key");
    mkdirSync(directory, { recursive: true });
    const source = join(directory, "session.jsonl");
    const records = [
      { type: "ai-title", sessionId: "workbuddy-session", cwd: projectRoot, timestamp: "2026-08-20T10:00:00.000Z", aiTitle: "Build MemoryGraph" },
      { type: "message", sessionId: "workbuddy-session", cwd: projectRoot, timestamp: "2026-08-20T10:01:00.000Z", role: "assistant", content: [{ type: "output_text", text: "Implemented the shared state adapter." }] },
      { type: "function_call", sessionId: "workbuddy-session", cwd: projectRoot, timestamp: "2026-08-20T10:02:00.000Z", name: "Bash", callId: "call-1", arguments: { command: "npm test" } },
    ];
    writeFileSync(source, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const database = new MemoryDatabase(join(temporary("memorygraph-workbuddy-store-"), "memorygraph.db"));
    const project = new MemoryGraphCore(database).resolveProject(projectRoot, true, "WorkBuddy Project");
    const adapter = new WorkBuddyAdapter(database, workbuddyRoot);
    expect(adapter.sync(project).ingested).toBe(3);
    expect(adapter.sync(project).ingested).toBe(0);
    database.close();
  });

  it("observes Trae workspaces without reading its opaque transcript store", () => {
    const projectRoot = temporary("memorygraph-trae-project-");
    const traeRoot = temporary("memorygraph-trae-source-");
    const workspaceStorage = join(traeRoot, "workspaceStorage");
    const workspaceDirectory = join(workspaceStorage, "workspace-id");
    mkdirSync(workspaceDirectory, { recursive: true });
    writeFileSync(join(workspaceDirectory, "workspace.json"), JSON.stringify({ workspace: projectRoot }));
    const opaqueStore = join(traeRoot, "database.db");
    writeFileSync(opaqueStore, Buffer.from([1, 2, 3, 4]));
    const database = new MemoryDatabase(join(temporary("memorygraph-trae-store-"), "memorygraph.db"));
    const project = new MemoryGraphCore(database).resolveProject(projectRoot, true, "Trae Project");
    const adapter = new TraeAdapter(database, [{ workspaceStorage, opaqueStore }]);
    const synced = adapter.sync(project);
    expect(synced.ingested).toBe(1);
    expect(synced.warnings[0]).toContain("opaque or encrypted");
    expect(database.recentEvents(project.projectId, 10)[0]?.agentId).toBe("trae");
    database.close();
  });
});
