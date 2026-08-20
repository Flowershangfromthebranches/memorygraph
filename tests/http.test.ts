import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createMemoryGraphHttpServer } from "../src/api/http-server.js";
import { MemoryGraphCore } from "../src/core/memorygraph-core.js";
import { MemoryDatabase } from "../src/storage/database.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("MemoryGraph HTTP API", () => {
  it("serves health and project graph data", async () => {
    const root = mkdtempSync(join(tmpdir(), "memorygraph-http-project-"));
    const data = mkdtempSync(join(tmpdir(), "memorygraph-http-data-"));
    cleanup.push(root, data);
    const database = new MemoryDatabase(join(data, "memorygraph.db"));
    const core = new MemoryGraphCore(database);
    const server = createMemoryGraphHttpServer(core);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const base = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${base}/api/health`).then((response) => response.json()) as Record<string, unknown>;
    expect(health.status).toBe("ok");

    const resolved = await fetch(`${base}/api/projects/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: root, create_if_missing: true, name: "HTTP Project" }),
    }).then((response) => response.json()) as Record<string, unknown>;
    expect(resolved.name).toBe("HTTP Project");
    const rememberedFact = core.remember({ cwd: root, agent: "codex", kind: "fact", title: "Storage", content: "SQLite", key: "storage" });

    const state = await fetch(`${base}/api/projects/${String(resolved.projectId)}/state`).then((response) => response.json()) as { facts: Array<{ predicate: string }> };
    expect(state.facts[0]?.predicate).toBe("storage");

    const privacy = await fetch(`${base}/api/projects/${String(resolved.projectId)}/privacy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ store_message_content: false, max_message_chars: 800, excluded_paths: [".env"] }),
    }).then((response) => response.json()) as { policy: { storeMessageContent: boolean; maxMessageChars: number } };
    expect(privacy.policy).toMatchObject({ storeMessageContent: false, maxMessageChars: 800 });

    const rejectedStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ hostname: "127.0.0.1", port: address.port, path: "/api/health", headers: { host: "evil.example" } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.once("error", reject);
      request.end();
    });
    expect(rejectedStatus).toBe(421);

    const atlas = await fetch(`${base}/api/graph`).then((response) => response.json()) as { nodes: unknown[]; truncated: boolean };
    expect(atlas).toMatchObject({ truncated: false });
    expect(atlas.nodes).toHaveLength(1);
    const graph = await fetch(`${base}/api/graph?projectId=${String(resolved.projectId)}&limit=100`).then((response) => response.json()) as { nodes: unknown[]; totalNodes: number };
    expect(graph.nodes.length).toBeGreaterThanOrEqual(2);
    expect(graph.totalNodes).toBe(graph.nodes.length);
    const neighborhood = await fetch(`${base}/api/nodes/${encodeURIComponent(rememberedFact.nodeId)}/neighborhood`).then((response) => response.json()) as { nodes: Array<{ id: string }> };
    expect(neighborhood.nodes.some((node) => node.id === rememberedFact.nodeId)).toBe(true);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
  });
});
