import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryGraphCore } from "../src/core/memorygraph-core.js";
import { GraphReplayer } from "../src/graph/replayer.js";
import { captureRepositorySnapshot, parsePorcelainZ } from "../src/core/repository-snapshot.js";
import { MemoryDatabase } from "../src/storage/database.js";

const cleanup: string[] = [];

function fixture(): { root: string; database: MemoryDatabase; core: MemoryGraphCore } {
  const root = mkdtempSync(join(tmpdir(), "memorygraph-core-"));
  cleanup.push(root);
  execFileSync("git", ["init", "--initial-branch=main", root]);
  writeFileSync(join(root, "README.md"), "# Fixture\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "-c", "user.name=MemoryGraph Test", "-c", "user.email=test@memorygraph.local", "commit", "-m", "initial"]);
  const database = new MemoryDatabase(join(root, "data", "memorygraph.db"));
  return { root, database, core: new MemoryGraphCore(database) };
}

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("MemoryGraphCore", () => {
  it("parses modified and renamed porcelain records without dropping path characters", () => {
    expect(parsePorcelainZ(" M web/src/App.tsx\0R  new-name.ts\0old-name.ts\0?? fresh.txt\0")).toEqual([
      "web/src/App.tsx",
      "new-name.ts",
      "fresh.txt",
    ]);
    const { root, database } = fixture();
    writeFileSync(join(root, "README.md"), "# Modified\n");
    expect(captureRepositorySnapshot(root).changedFiles).toContain("README.md");
    database.close();
  });

  it("creates a stable project identity and resolves it from descendants", () => {
    const { root, database, core } = fixture();
    const first = core.resolveProject(root, true, "Example Project");
    const second = core.resolveProject(join(root, "nested", "path"), false);

    expect(second.projectId).toBe(first.projectId);
    const identity = JSON.parse(readFileSync(join(root, ".memorygraph", "project.json"), "utf8")) as Record<string, unknown>;
    expect(identity.project_id).toBe(first.projectId);
    const secondRoot = mkdtempSync(join(tmpdir(), "memorygraph-attached-root-"));
    cleanup.push(secondRoot);
    expect(core.attachProjectRoot(first.projectId, secondRoot).primaryRoot).toBe(root);
    expect(core.resolveProject(root, false).primaryRoot).toBe(root);
    expect(core.resolveProject(secondRoot, false).projectId).toBe(first.projectId);
    expect(core.attachProjectRoot(first.projectId, secondRoot, true).primaryRoot).toBe(secondRoot);
    database.close();
  });

  it("keeps history while projecting only the latest state", () => {
    const { root, database, core } = fixture();
    core.remember({ cwd: root, agent: "codex", kind: "state", title: "Database", content: "SQLite", key: "database", value: "sqlite", occurredAt: "2026-08-20T10:00:00.000Z" });
    const decision = { cwd: root, agent: "codex", kind: "decision" as const, title: "Use SQLite locally", content: "It keeps the raw event authority local and replayable." };
    core.remember(decision);
    core.remember(decision);
    const currentDatabaseState = { cwd: root, agent: "codex", kind: "state" as const, title: "Database", content: "SQLite with optional Neo4j projection", key: "database", value: "sqlite+neo4j", occurredAt: "2026-08-20T11:00:00.000Z" };
    core.remember(currentDatabaseState);
    core.remember(currentDatabaseState);

    const state = core.projectState(root);
    expect(state.state).toHaveLength(1);
    expect(state.state[0]?.value).toBe("sqlite+neo4j");
    expect(database.stateHistory(state.project.projectId)).toHaveLength(2);
    expect(state.decisions[0]?.title).toBe("Use SQLite locally");
    expect(state.decisions).toHaveLength(1);
    expect(core.search(root, "SQLite").hits.length).toBeGreaterThan(0);
    const diff = core.memoryDiff(root, "2026-08-20T10:30:00.000Z", "2026-08-20T11:30:00.000Z");
    expect(diff.changed[0]?.before.value).toBe("sqlite");
    expect(diff.changed[0]?.after.value).toBe("sqlite+neo4j");
    database.close();
  });

  it("stores facts separately from state and closes superseded fact validity", () => {
    const { root, database, core } = fixture();
    core.remember({ cwd: root, agent: "codex", kind: "fact", title: "Graph backend", content: "Neo4j 2026.06", key: "graph_backend", occurredAt: "2026-08-20T10:00:00.000Z" });
    const currentFact = { cwd: root, agent: "codex", kind: "fact" as const, title: "Graph backend", content: "Neo4j 2026.07", key: "graph_backend", occurredAt: "2026-08-20T11:00:00.000Z" };
    core.remember(currentFact);
    core.remember(currentFact);
    const project = core.resolveProject(root, false);
    expect(database.listFacts(project.projectId)).toMatchObject([{ predicate: "graph_backend", objectText: "Neo4j 2026.07", validTo: null }]);
    const history = database.listFacts(project.projectId, 10, true);
    expect(history).toHaveLength(2);
    expect(history[1]?.validTo).toBe("2026-08-20T11:00:00.000Z");
    expect(core.resumeProject({ cwd: root, receivingAgent: "opencode", tokenBudget: 2_000 }).recentFacts[0]?.objectText).toBe("Neo4j 2026.07");
    database.close();
  });

  it("marks superseded decisions deprecated and links their graph nodes", () => {
    const { root, database, core } = fixture();
    const first = core.remember({ cwd: root, agent: "codex", kind: "decision", title: "Use REST", content: "Initial interface choice." });
    const oldDecision = database.recentDecisions(first.project.projectId)[0]!;
    const replacement = core.remember({ cwd: root, agent: "codex", kind: "decision", title: "Use MCP", content: "Cross-agent clients need a shared protocol.", supersedesDecisionId: oldDecision.id });
    expect(database.recentDecisions(first.project.projectId).map((decision) => decision.title)).toEqual(["Use MCP"]);
    const graph = database.graph(first.project.projectId);
    expect(graph.nodes.find((node) => node.id === first.nodeId)?.status).toBe("deprecated");
    expect(graph.edges.some((edge) => edge.source === replacement.nodeId && edge.target === first.nodeId && edge.type === "SUPERSEDES")).toBe(true);
    new GraphReplayer(database).rebuildProject(first.project.projectId);
    expect(database.graph(first.project.projectId).nodes.find((node) => node.id === first.nodeId)?.status).toBe("deprecated");
    database.close();
  });

  it("creates a consistent online backup", async () => {
    const { root, database, core } = fixture();
    core.remember({ cwd: root, agent: "codex", kind: "state", title: "Phase", content: "Core", key: "phase", value: "core" });
    const backupPath = join(root, "backup", "memorygraph.db");
    await database.backup(backupPath);
    const restored = new MemoryDatabase(backupPath);
    const project = restored.findProjectForPath(root);
    expect(project).not.toBeNull();
    expect(restored.currentState(project!.projectId)[0]?.value).toBe("core");
    const exported = database.exportProject(project!.projectId);
    expect((exported.events as unknown[]).length).toBeGreaterThan(0);
    expect(exported.schemaVersion).toBe(1);
    restored.close();
    database.close();
  });

  it("links projects for the workspace Atlas without duplicating the edge", () => {
    const { root, database, core } = fixture();
    const secondRoot = mkdtempSync(join(tmpdir(), "memorygraph-second-project-"));
    cleanup.push(secondRoot);
    core.resolveProject(root, true, "First Project");
    core.resolveProject(secondRoot, true, "Second Project");
    const first = core.linkProjects({ sourceCwd: root, targetCwd: secondRoot, relation: "DEPENDS_ON", agent: "codex" });
    const second = core.linkProjects({ sourceCwd: root, targetCwd: secondRoot, relation: "DEPENDS_ON", agent: "codex" });
    expect(second.edgeId).toBe(first.edgeId);
    const atlas = database.graph();
    expect(atlas.nodes.filter((node) => node.type === "Project")).toHaveLength(2);
    expect(atlas.edges.filter((edge) => edge.type === "DEPENDS_ON")).toHaveLength(1);
    new GraphReplayer(database).rebuildProject(first.target.projectId);
    expect(database.graph().edges.filter((edge) => edge.type === "DEPENDS_ON")).toHaveLength(1);
    database.close();
  });

  it("returns a bounded project graph slice while Atlas only returns projects", () => {
    const { root, database, core } = fixture();
    const project = core.resolveProject(root, true, "Slice Project");
    for (let index = 0; index < 140; index += 1) {
      database.upsertNode({ id: `slice-${index}`, projectId: project.projectId, type: "Concept", label: `Concept ${index}` });
      database.addEdge({ id: `slice-edge-${index}`, projectId: project.projectId, sourceNodeId: `project:${project.projectId}`, targetNodeId: `slice-${index}`, type: "CONTAINS" });
    }
    const slice = database.graphSlice(project.projectId, 100);
    expect(slice).toMatchObject({ totalNodes: 141, truncated: true });
    expect(slice.nodes).toHaveLength(100);
    const neighborhood = database.nodeNeighborhood(`project:${project.projectId}`, 10);
    expect(neighborhood).toMatchObject({ totalEdges: 140, truncated: true });
    expect(neighborhood?.nodes).toHaveLength(11);
    expect(database.atlasGraph().nodes).toHaveLength(1);
    database.close();
  });

  it("rebuilds the local graph projection from durable records", () => {
    const { root, database, core } = fixture();
    const remembered = core.remember({ cwd: root, agent: "codex", kind: "task", title: "Replay task", content: "Rebuild this node." });
    const handoff = core.resumeProject({ cwd: root, receivingAgent: "opencode", tokenBudget: 2_000 });
    database.upsertNode({ id: "corrupt:temporary", projectId: remembered.project.projectId, type: "Concept", label: "Should disappear" });

    const report = new GraphReplayer(database).rebuildProject(remembered.project.projectId);
    const graph = database.graph(remembered.project.projectId);
    expect(report.eventsReplayed).toBeGreaterThanOrEqual(2);
    expect(graph.nodes.some((node) => node.id === remembered.nodeId)).toBe(true);
    expect(graph.nodes.some((node) => node.id === handoff.handoffId)).toBe(true);
    expect(graph.nodes.some((node) => node.id === "corrupt:temporary")).toBe(false);
    database.close();
  });

  it("keeps the compiled handoff at or below the requested token ceiling", () => {
    const { root, database, core } = fixture();
    for (let index = 0; index < 24; index += 1) {
      core.remember({ cwd: root, agent: "codex", kind: "task", title: `Task ${index}`, content: `Detailed active work ${index} ${"context ".repeat(20)}` });
    }
    const noisySync = {
      syncProject: () => Array.from({ length: 5 }, (_, index) => ({
        adapterId: `adapter-${index}`,
        sourceKey: root,
        scanned: 100,
        ingested: 0,
        skipped: 100,
        cursor: {},
        warnings: [`${"adapter warning ".repeat(20)}${index}`],
      })),
    };
    const context = new MemoryGraphCore(database, noisySync).resumeProject({ cwd: root, receivingAgent: "opencode", tokenBudget: 800 });
    expect(context.estimatedTokens).toBeLessThanOrEqual(800);
    database.close();
  });

  it("creates a pull-based handoff with live repository evidence", () => {
    const { root, database, core } = fixture();
    core.remember({ cwd: root, agent: "codex", kind: "task", title: "Build adapter", content: "Implement the OpenCode cursor parser.", status: "active" });
    writeFileSync(join(root, "work-in-progress.txt"), "do not overwrite\n");

    const context = core.resumeProject({ cwd: root, receivingAgent: "opencode", tokenBudget: 2_000 });

    expect(context.previousAgent).toBe("codex");
    expect(context.selectionReasons.repository).toContain("Live Git snapshot");
    expect(context.repository.dirty).toBe(true);
    expect(context.repository.changedFiles).toContain("work-in-progress.txt");
    expect(context.nextSteps[0]).toContain("Build adapter");
    expect(context.handoffId).toMatch(/^handoff_/u);
    core.remember({
      cwd: root,
      agent: "opencode",
      kind: "task",
      title: "Adapter continued",
      content: "OpenCode resumed from the handoff.",
      occurredAt: new Date(Date.now() + 1_000).toISOString(),
    });
    core.resumeProject({ cwd: root, receivingAgent: "codex", tokenBudget: 2_000 });
    const completed = database.listHandoffs(context.project.projectId).find((handoff) => handoff.id === context.handoffId);
    expect(completed?.outcomeStatus).toBe("continued");
    const projectNode = database.graph(context.project.projectId).nodes.find((node) => node.type === "Project");
    expect(projectNode?.validFrom).toBe(context.project.createdAt);
    database.close();
  });
});
