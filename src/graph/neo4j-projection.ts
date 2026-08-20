import neo4j, { type Driver } from "neo4j-driver";

import { MemoryDatabase } from "../storage/database.js";
import type { GraphProjection, ProjectionReport } from "./types.js";

export interface Neo4jProjectionOptions {
  uri: string;
  username: string;
  password: string;
  database?: string;
}

function properties(value: Record<string, unknown>): Record<string, string | number | boolean | null> {
  return {
    id: String(value.id),
    projectId: String(value.projectId),
    type: String(value.type),
    status: String(value.status),
    validFrom: String(value.validFrom),
    validTo: value.validTo === null ? null : String(value.validTo),
    sourceEventId: value.sourceEventId === null ? null : String(value.sourceEventId),
  };
}

export class Neo4jProjection implements GraphProjection {
  readonly id = "neo4j";
  private readonly driver: Driver;
  private readonly databaseName: string;

  constructor(private readonly source: MemoryDatabase, options: Neo4jProjectionOptions) {
    this.driver = neo4j.driver(options.uri, neo4j.auth.basic(options.username, options.password));
    this.databaseName = options.database ?? "neo4j";
  }

  async verify(): Promise<void> {
    await this.driver.verifyConnectivity();
    const session = this.driver.session({ database: this.databaseName });
    try {
      await session.run("CREATE CONSTRAINT memorygraph_node_id IF NOT EXISTS FOR (n:MemoryGraphNode) REQUIRE n.id IS UNIQUE");
      await session.run("CREATE INDEX memorygraph_project_id IF NOT EXISTS FOR (n:MemoryGraphNode) ON (n.projectId)");
    } finally {
      await session.close();
    }
  }

  async rebuildProject(projectId: string): Promise<ProjectionReport> {
    const startedAt = new Date().toISOString();
    const graph = this.source.graph(projectId);
    const nodes = graph.nodes.map((node) => ({
      ...properties(node),
      label: String(node.label),
      summary: String(node.summary),
      attributesJson: JSON.stringify(node.attributes ?? {}),
    }));
    const edges = graph.edges.map((edge) => ({
      ...properties(edge),
      source: String(edge.source),
      target: String(edge.target),
      attributesJson: JSON.stringify(edge.attributes ?? {}),
    }));
    const session = this.driver.session({ database: this.databaseName });
    try {
      await session.executeWrite(async (transaction) => {
        await transaction.run("MATCH (n:MemoryGraphNode {projectId: $projectId}) DETACH DELETE n", { projectId });
        if (nodes.length > 0) {
          await transaction.run(
            `UNWIND $nodes AS node
             CREATE (n:MemoryGraphNode)
             SET n = node`,
            { nodes },
          );
        }
        if (edges.length > 0) {
          await transaction.run(
            `UNWIND $edges AS edge
             MATCH (source:MemoryGraphNode {id: edge.source}), (target:MemoryGraphNode {id: edge.target})
             CREATE (source)-[relation:MEMORYGRAPH_RELATION]->(target)
             SET relation = edge`,
            { edges },
          );
        }
      });
    } finally {
      await session.close();
    }
    return { backend: this.id, projectId, nodes: nodes.length, edges: edges.length, startedAt, completedAt: new Date().toISOString() };
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

