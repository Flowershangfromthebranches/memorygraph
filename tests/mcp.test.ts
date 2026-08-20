import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryGraphCore } from "../src/core/memorygraph-core.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { MemoryDatabase } from "../src/storage/database.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("MemoryGraph MCP", () => {
  it("exposes the six-tool surface and calls remember through a real MCP transport", async () => {
    const root = mkdtempSync(join(tmpdir(), "memorygraph-mcp-project-"));
    const data = mkdtempSync(join(tmpdir(), "memorygraph-mcp-data-"));
    cleanup.push(root, data);
    const database = new MemoryDatabase(join(data, "memorygraph.db"));
    const server = buildMcpServer(new MemoryGraphCore(database));
    const client = new Client({ name: "memorygraph-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "explain", "project_state", "remember", "resume_project", "search", "trace",
    ]);
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((resource) => resource.uriTemplate).sort()).toEqual([
      "memory://project/{projectId}/decisions",
      "memory://project/{projectId}/handoffs",
      "memory://project/{projectId}/issues",
      "memory://project/{projectId}/state",
      "memory://project/{projectId}/timeline",
    ]);

    const remembered = await client.callTool({
      name: "remember",
      arguments: {
        cwd: root,
        agent: "codex",
        kind: "state",
        title: "Current phase",
        content: "Memory Core",
        key: "phase",
      },
    });
    expect(remembered.isError).not.toBe(true);

    const state = await client.callTool({ name: "project_state", arguments: { cwd: root } });
    expect(JSON.stringify(state)).toContain("Memory Core");

    await client.close();
    await server.close();
    database.close();
  });
});
