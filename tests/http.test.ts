import { mkdtempSync, rmSync } from "node:fs";
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

    const graph = await fetch(`${base}/api/graph`).then((response) => response.json()) as { nodes: unknown[] };
    expect(graph.nodes).toHaveLength(1);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
  });
});

