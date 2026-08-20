import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import neo4j from "neo4j-driver";
import { afterAll, describe, expect, it } from "vitest";

import { MemoryGraphCore } from "../src/core/memorygraph-core.js";
import { Neo4jProjection } from "../src/graph/neo4j-projection.js";
import { MemoryDatabase } from "../src/storage/database.js";

const enabled = process.env.NEO4J_TEST === "1";
const temporary = enabled ? mkdtempSync(join(tmpdir(), "memorygraph-neo4j-")) : "";

afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

describe.skipIf(!enabled)("Neo4j projection", () => {
  it("rebuilds and independently queries a project projection", async () => {
    const password = process.env.NEO4J_PASSWORD;
    if (!password) throw new Error("NEO4J_PASSWORD is required");
    const database = new MemoryDatabase(join(temporary, "memorygraph.db"));
    const root = join(temporary, "project");
    const core = new MemoryGraphCore(database);
    const remembered = core.remember({ cwd: root, agent: "codex", kind: "task", title: "Projection test", content: "Verify Neo4j." });
    const options = { uri: process.env.NEO4J_URI ?? "bolt://127.0.0.1:7687", username: process.env.NEO4J_USER ?? "neo4j", password, database: process.env.NEO4J_DATABASE ?? "neo4j" };
    const projection = new Neo4jProjection(database, options);
    await projection.verify();
    const report = await projection.rebuildProject(remembered.project.projectId);
    expect(report.nodes).toBeGreaterThanOrEqual(2);
    expect(report.edges).toBeGreaterThanOrEqual(1);

    const driver = neo4j.driver(options.uri, neo4j.auth.basic(options.username, options.password));
    const session = driver.session({ database: options.database });
    try {
      const result = await session.run(
        "MATCH (n:MemoryGraphNode {projectId: $projectId}) OPTIONAL MATCH (n)-[r:MEMORYGRAPH_RELATION]->() RETURN count(DISTINCT n) AS nodes, count(r) AS edges",
        { projectId: remembered.project.projectId },
      );
      expect(result.records[0]?.get("nodes").toNumber()).toBe(report.nodes);
      expect(result.records[0]?.get("edges").toNumber()).toBe(report.edges);
      await session.run("MATCH (n:MemoryGraphNode {projectId: $projectId}) DETACH DELETE n", { projectId: remembered.project.projectId });
    } finally {
      await session.close();
      await driver.close();
      await projection.close();
      database.close();
    }
  });
});

