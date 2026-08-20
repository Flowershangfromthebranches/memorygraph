import { createHash } from "node:crypto";

import type { EdgeType, EntityStatus, NodeType, RepositorySnapshot } from "../domain/types.js";
import { EDGE_TYPES } from "../domain/types.js";
import { MemoryDatabase } from "../storage/database.js";

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function status(value: unknown): EntityStatus { return ["planned", "active", "blocked", "complete", "deprecated"].includes(String(value)) ? value as EntityStatus : "active"; }

function memoryNodeType(kind: string): NodeType {
  if (kind === "decision") return "Decision";
  if (kind === "issue") return "Issue";
  if (kind === "task") return "Task";
  if (kind === "requirement") return "Requirement";
  if (kind === "milestone") return "Milestone";
  if (kind === "state") return "State";
  return "Concept";
}

export class GraphReplayer {
  constructor(private readonly database: MemoryDatabase) {}

  rebuildProject(projectId: string): { projectId: string; nodes: number; edges: number; eventsReplayed: number } {
    const project = this.database.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const events = this.database.allEvents(projectId);
    const sessions = this.database.listSessions(projectId);
    const handoffs = this.database.listHandoffs(projectId, 10_000);
    this.database.clearProjectGraph(projectId);
    this.database.upsertNode({ id: `project:${projectId}`, projectId, type: "Project", label: project.name, status: "active", summary: `Project ${project.name}`, attributes: { slug: project.slug, root: project.primaryRoot }, validFrom: project.createdAt });

    for (const session of sessions) {
      this.database.linkSessionGraph({ projectId, projectName: project.name, agentId: session.agentId, sessionId: session.id, externalId: session.externalId, title: session.summary, startedAt: session.startedAt });
    }

    const latestMessageByAgent = new Map<string, (typeof events)[number]>();
    for (const event of events) {
      const payload = event.payload;
      const memoryKind = typeof payload.kind === "string" ? payload.kind : null;
      const content = typeof payload.content === "string" ? payload.content : "";
      if (memoryKind) {
        const nodeId = `${memoryKind}:${projectId}:${hash(`${event.summary}\0${content}`).slice(0, 20)}`;
        this.database.upsertNode({ id: nodeId, projectId, type: memoryNodeType(memoryKind), label: event.summary, status: status(payload.status), summary: content, attributes: { kind: memoryKind, agent: event.agentId }, validFrom: event.occurredAt, sourceEventId: event.id });
        this.database.addEdge({ id: `edge:${projectId}:${nodeId}:contains`, projectId, sourceNodeId: `project:${projectId}`, targetNodeId: nodeId, type: "CONTAINS", status: status(payload.status), validFrom: event.occurredAt, sourceEventId: event.id });
      }
      if (event.kind === "message") latestMessageByAgent.set(event.agentId, event);
      const sourceProjectId = typeof payload.sourceProjectId === "string" ? payload.sourceProjectId : null;
      const targetProjectId = typeof payload.targetProjectId === "string" ? payload.targetProjectId : null;
      const relation = typeof payload.relation === "string" && EDGE_TYPES.includes(payload.relation as EdgeType) ? payload.relation as EdgeType : null;
      if (sourceProjectId === projectId && targetProjectId && relation) {
        const target = this.database.getProject(targetProjectId);
        if (target) {
          this.database.upsertNode({ id: `project:${targetProjectId}`, projectId: targetProjectId, type: "Project", label: target.name, status: "active", summary: `Project ${target.name}`, validFrom: target.createdAt });
          this.database.addEdge({ id: `edge:${sourceProjectId}:${targetProjectId}:${relation}`, projectId, sourceNodeId: `project:${sourceProjectId}`, targetNodeId: `project:${targetProjectId}`, type: relation, attributes: { summary: event.summary, crossProject: true }, validFrom: event.occurredAt, sourceEventId: event.id });
        }
      }
    }

    for (const [agent, event] of latestMessageByAgent) {
      const taskNode = `activity:${projectId}:${agent}`;
      const agentNode = `agent:${agent}`;
      this.database.upsertNode({ id: agentNode, projectId, type: "Agent", label: agent, status: "active", attributes: { agentId: agent }, validFrom: event.occurredAt });
      this.database.upsertNode({ id: taskNode, projectId, type: "Task", label: `${agent} latest activity`, status: "active", summary: event.summary, attributes: { agent, automaticallyProjected: true, sourceUri: event.sourceUri }, validFrom: event.occurredAt, sourceEventId: event.id });
      this.database.addEdge({ id: `edge:project:${projectId}:${taskNode}:contains`, projectId, sourceNodeId: `project:${projectId}`, targetNodeId: taskNode, type: "CONTAINS", validFrom: event.occurredAt, sourceEventId: event.id });
      this.database.addEdge({ id: `edge:${taskNode}:${agentNode}:modified-by`, projectId, sourceNodeId: taskNode, targetNodeId: agentNode, type: "MODIFIED_BY", validFrom: event.occurredAt, sourceEventId: event.id });
    }

    for (const handoff of handoffs) {
      const context = object(handoff.context);
      const event = events.find((candidate) => object(candidate.payload)?.handoffId === handoff.id);
      this.database.recordHandoffGraph({
        handoffId: String(handoff.id),
        projectId,
        projectName: project.name,
        previousAgent: typeof handoff.previousAgent === "string" ? handoff.previousAgent : null,
        receivingAgent: String(handoff.receivingAgent),
        createdAt: String(handoff.createdAt),
        status: handoff.outcomeStatus === "pending" ? "active" : "complete",
        ...(event ? { sourceEventId: event.id } : {}),
      });
      const repository = context ? object(context.repository) : null;
      if (repository && typeof repository.root === "string" && typeof repository.capturedAt === "string" && Array.isArray(repository.changedFiles)) {
        this.database.projectRepositoryGraph({
          project,
          snapshot: repository as unknown as RepositorySnapshot,
          agentId: typeof handoff.previousAgent === "string" ? handoff.previousAgent : null,
          ...(event ? { sourceEventId: event.id } : {}),
        });
      }
    }
    const graph = this.database.graph(projectId);
    return { projectId, nodes: graph.nodes.length, edges: graph.edges.length, eventsReplayed: events.length };
  }
}
