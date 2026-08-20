import { createHash } from "node:crypto";

import type {
  EdgeType,
  EntityStatus,
  NodeType,
  ProjectIdentity,
  ResumeContext,
  SearchHit,
} from "../domain/types.js";
import type { ProjectSyncService } from "../adapters/types.js";
import { MemoryDatabase } from "../storage/database.js";
import { ProjectResolver } from "./project-resolver.js";
import { captureRepositorySnapshot } from "./repository-snapshot.js";

export type RememberKind = "fact" | "state" | "decision" | "issue" | "task" | "requirement" | "milestone" | "note";

export interface RememberInput {
  cwd: string;
  agent: string;
  kind: RememberKind;
  title: string;
  content: string;
  key?: string;
  value?: unknown;
  status?: EntityStatus;
  sourceUri?: string;
  sessionId?: string;
  occurredAt?: string;
  confidence?: number;
  supersedesDecisionId?: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nodeTypeFor(kind: RememberKind): NodeType {
  switch (kind) {
    case "decision": return "Decision";
    case "issue": return "Issue";
    case "task": return "Task";
    case "requirement": return "Requirement";
    case "milestone": return "Milestone";
    case "state": return "State";
    default: return "Concept";
  }
}

function eventKindFor(kind: RememberKind): "memory" | "state_change" | "decision" | "issue" {
  if (kind === "state") return "state_change";
  if (kind === "decision") return "decision";
  if (kind === "issue") return "issue";
  return "memory";
}

function projectNodeId(projectId: string): string {
  return `project:${projectId}`;
}

export class MemoryGraphCore {
  readonly resolver: ProjectResolver;

  constructor(readonly database: MemoryDatabase, private readonly syncService?: ProjectSyncService) {
    this.resolver = new ProjectResolver(database);
  }

  syncProject(cwd: string) {
    const project = this.resolveProject(cwd, false);
    const results = this.syncService?.syncProject(project) ?? [];
    const projectedAgents = this.projectLatestAgentState(project);
    this.database.updateHandoffOutcomes(project.projectId);
    return { project, results, projectedAgents };
  }

  syncAllProjects() {
    return this.database.listProjects().map((project) => this.syncProject(project.primaryRoot));
  }

  resolveProject(cwd: string, createIfMissing = true, name?: string): ProjectIdentity {
    const options = name === undefined ? { cwd, createIfMissing } : { cwd, createIfMissing, name };
    const project = this.resolver.resolve(options);
    this.ensureProjectNode(project);
    return project;
  }

  remember(input: RememberInput): { project: ProjectIdentity; eventId: string; nodeId: string } {
    const project = this.resolveProject(input.cwd, true);
    const sourceUri = input.sourceUri ?? `manual://${input.agent}`;
    const dedupeKey = hash(JSON.stringify({
      project: project.projectId,
      kind: input.kind,
      agent: input.agent,
      title: input.title,
      content: input.content,
      sourceUri,
      occurredAt: input.occurredAt,
    }));
    const event = this.database.appendEvent({
      projectId: project.projectId,
      agentId: input.agent,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      kind: eventKindFor(input.kind),
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      sourceUri,
      dedupeKey,
      summary: input.title,
      payload: {
        kind: input.kind,
        content: input.content,
        ...(input.key === undefined ? {} : { key: input.key }),
        ...(input.value === undefined ? {} : { value: input.value }),
        status: input.status ?? "active",
      },
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    });
    this.database.addEvidence({
      projectId: project.projectId,
      eventId: event.id,
      uri: sourceUri,
      kind: sourceUri.startsWith("file:") ? "file" : sourceUri.startsWith("git:") ? "git" : "manual",
    });

    if (input.kind === "state") {
      const key = input.key?.trim() || input.title.trim();
      const value = input.value ?? input.content;
      this.database.setState({
        projectId: project.projectId,
        key,
        value,
        valueText: input.content,
        status: input.status ?? "active",
        ...(input.occurredAt === undefined ? {} : { validFrom: input.occurredAt }),
        sourceEventId: event.id,
      });
    }

    if (input.kind === "decision") {
      this.database.addDecision({
        projectId: project.projectId,
        title: input.title,
        rationale: input.content,
        status: input.status ?? "active",
        ...(input.occurredAt === undefined ? {} : { decidedAt: input.occurredAt }),
        ...(input.supersedesDecisionId === undefined ? {} : { supersedesId: input.supersedesDecisionId }),
        eventId: event.id,
      });
    }

    const nodeId = this.database.upsertNode({
      id: `${input.kind}:${project.projectId}:${hash(`${input.title}\0${input.content}`).slice(0, 20)}`,
      projectId: project.projectId,
      type: nodeTypeFor(input.kind),
      label: input.title,
      status: input.status ?? "active",
      summary: input.content,
      attributes: { kind: input.kind, agent: input.agent },
      ...(input.occurredAt === undefined ? {} : { validFrom: input.occurredAt }),
      sourceEventId: event.id,
    });
    try {
      this.database.addEdge({
        id: `edge:${project.projectId}:${nodeId}:contains`,
        projectId: project.projectId,
        sourceNodeId: projectNodeId(project.projectId),
        targetNodeId: nodeId,
        type: "CONTAINS",
        status: input.status ?? "active",
        sourceEventId: event.id,
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("UNIQUE constraint failed")) throw error;
    }
    return { project, eventId: event.id, nodeId };
  }

  projectState(cwd: string): {
    project: ProjectIdentity;
    repository: ReturnType<typeof captureRepositorySnapshot>;
    state: ReturnType<MemoryDatabase["currentState"]>;
    activeWork: ReturnType<MemoryDatabase["activeNodes"]>;
    decisions: ReturnType<MemoryDatabase["recentDecisions"]>;
  } {
    const project = this.resolveProject(cwd, false);
    const workTypes = new Set(["Workstream", "Requirement", "Task", "Issue", "Milestone"]);
    return {
      project,
      repository: captureRepositorySnapshot(project.primaryRoot),
      state: this.database.currentState(project.projectId),
      activeWork: this.database.activeNodes(project.projectId, 200).filter((node) => workTypes.has(node.type)).slice(0, 50),
      decisions: this.database.recentDecisions(project.projectId),
    };
  }

  search(cwd: string, query: string, limit = 20): { project: ProjectIdentity; hits: SearchHit[] } {
    const project = this.resolveProject(cwd, false);
    return { project, hits: this.database.search(project.projectId, query, limit) };
  }

  trace(cwd: string, agent: string, topic?: string, limit = 30): {
    project: ProjectIdentity;
    agent: string;
    events: ReturnType<MemoryDatabase["recentEvents"]>;
  } {
    const project = this.resolveProject(cwd, false);
    const events = this.database.recentEvents(project.projectId, Math.max(limit * 4, 100))
      .filter((event) => event.agentId === agent)
      .filter((event) => !topic || event.summary.toLocaleLowerCase().includes(topic.toLocaleLowerCase()))
      .slice(0, limit);
    return { project, agent, events };
  }

  explain(cwd: string, question: string, limit = 8): {
    project: ProjectIdentity;
    question: string;
    decisions: ReturnType<MemoryDatabase["recentDecisions"]>;
    supportingEvents: SearchHit[];
  } {
    const project = this.resolveProject(cwd, false);
    const terms = question.trim().toLocaleLowerCase().split(/\s+/u).filter((term) => term.length > 1);
    const decisions = this.database.recentDecisions(project.projectId, 50)
      .map((decision) => ({
        decision,
        score: terms.reduce((score, term) => score + (`${decision.title} ${decision.rationale}`.toLocaleLowerCase().includes(term) ? 1 : 0), 0),
      }))
      .filter((entry) => entry.score > 0 || terms.length === 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.decision);
    return {
      project,
      question,
      decisions,
      supportingEvents: this.database.search(project.projectId, question, limit),
    };
  }

  memoryDiff(cwd: string, from: string, to: string) {
    const project = this.resolveProject(cwd, false);
    return { project, ...this.database.diffState(project.projectId, from, to) };
  }

  linkProjects(input: { sourceCwd: string; targetCwd: string; relation: EdgeType; agent?: string; summary?: string }) {
    const source = this.resolveProject(input.sourceCwd, false);
    const target = this.resolveProject(input.targetCwd, false);
    const occurredAt = new Date().toISOString();
    const summary = input.summary ?? `${source.name} ${input.relation.toLocaleLowerCase().replaceAll("_", " ")} ${target.name}`;
    const event = this.database.appendEvent({
      projectId: source.projectId,
      agentId: input.agent ?? "manual",
      kind: "memory",
      occurredAt,
      sourceUri: `memorygraph://project-link/${source.projectId}/${target.projectId}`,
      dedupeKey: hash(`project-link\0${source.projectId}\0${target.projectId}\0${input.relation}`),
      summary,
      payload: { sourceProjectId: source.projectId, targetProjectId: target.projectId, relation: input.relation },
    });
    const edgeId = this.database.addEdge({
      id: `edge:${source.projectId}:${target.projectId}:${input.relation}`,
      projectId: source.projectId,
      sourceNodeId: projectNodeId(source.projectId),
      targetNodeId: projectNodeId(target.projectId),
      type: input.relation,
      status: "active",
      attributes: { summary, crossProject: true },
      validFrom: occurredAt,
      sourceEventId: event.id,
    });
    return { source, target, edgeId, eventId: event.id, relation: input.relation, summary };
  }

  resumeProject(input: { cwd: string; receivingAgent: string; tokenBudget?: number }): ResumeContext {
    const project = this.resolveProject(input.cwd, true);
    const sync = this.syncService?.syncProject(project) ?? [];
    this.projectLatestAgentState(project);
    this.database.updateHandoffOutcomes(project.projectId);
    let repository = captureRepositorySnapshot(project.primaryRoot);
    let currentState = this.database.currentState(project.projectId, 40);
    const workTypes = new Set(["Workstream", "Requirement", "Task", "Issue", "Milestone"]);
    let activeWork = this.database.activeNodes(project.projectId, 200).filter((node) => workTypes.has(node.type)).slice(0, 40).map((node) => ({ ...node, type: node.type as NodeType }));
    let recentDecisions = this.database.recentDecisions(project.projectId, 8);
    let recentEvents = this.database.recentEvents(project.projectId, 20);
    let compiledSync = sync;
    const previousAgent = this.database.previousAgent(project.projectId, input.receivingAgent);
    this.database.projectRepositoryGraph({
      project,
      snapshot: repository,
      agentId: previousAgent,
      ...(recentEvents[0] ? { sourceEventId: recentEvents[0].id } : {}),
    });
    let nextSteps = activeWork
      .filter((node) => node.type === "Task" || node.type === "Issue" || node.status === "blocked")
      .slice(0, 8)
      .map((node) => `${node.status === "blocked" ? "Unblock" : "Continue"}: ${node.label}${node.summary ? ` — ${node.summary}` : ""}`);
    const warnings: string[] = [];
    if (repository.error) warnings.push(`Repository verification incomplete: ${repository.error}`);
    if (repository.dirty) warnings.push(`Repository has ${repository.changedFiles.length} uncommitted file change(s); preserve them.`);
    if (recentEvents.length === 0) warnings.push("No prior agent events have been ingested for this project yet.");
    for (const adapter of sync) warnings.push(...adapter.warnings.map((warning) => `${adapter.adapterId}: ${warning}`));

    const requestedBudget = input.tokenBudget ?? 1_500;
    const buildContext = () => ({
      project,
      receivingAgent: input.receivingAgent,
      previousAgent,
      generatedAt: new Date().toISOString(),
      repository,
      currentState,
      activeWork,
      recentDecisions,
      recentEvents,
      sync: compiledSync,
      nextSteps,
      warnings,
    });
    const estimate = () => Math.ceil(JSON.stringify(buildContext()).length / 4);
    let truncated = false;
    while (estimate() > requestedBudget) {
      truncated = true;
      if (recentEvents.length > 3) recentEvents = recentEvents.slice(0, Math.max(3, recentEvents.length - 3));
      else if (activeWork.length > 5) activeWork = activeWork.slice(0, Math.max(5, activeWork.length - 3));
      else if (recentDecisions.length > 3) recentDecisions = recentDecisions.slice(0, recentDecisions.length - 1);
      else if (currentState.length > 8) currentState = currentState.slice(0, currentState.length - 2);
      else if (repository.changedFiles.length > 20) repository = { ...repository, changedFiles: repository.changedFiles.slice(0, 20) };
      else if (compiledSync.length > 0) compiledSync = [];
      else if (nextSteps.length > 3) nextSteps = nextSteps.slice(0, 3);
      else break;
    }
    if (truncated) warnings.push(`Context was layered and trimmed to honor the ${requestedBudget}-token budget; use search, trace, or explain for deeper history.`);
    const contextWithoutHandoff = buildContext();
    const estimatedTokens = Math.ceil(JSON.stringify(contextWithoutHandoff).length / 4);
    const handoffId = this.database.createHandoff({
      projectId: project.projectId,
      previousAgent,
      receivingAgent: input.receivingAgent,
      context: contextWithoutHandoff,
      inheritedEventIds: recentEvents.map((event) => event.id),
      estimatedTokens,
    });
    const handoffEvent = this.database.appendEvent({
      projectId: project.projectId,
      agentId: input.receivingAgent,
      kind: "handoff",
      occurredAt: contextWithoutHandoff.generatedAt,
      sourceUri: `memorygraph://handoff/${handoffId}`,
      dedupeKey: hash(`handoff\0${handoffId}`),
      summary: `${previousAgent ?? "project state"} → ${input.receivingAgent}`,
      payload: { handoffId, previousAgent, receivingAgent: input.receivingAgent, inheritedEventIds: recentEvents.map((event) => event.id), estimatedTokens },
    });
    this.database.addEvidence({ projectId: project.projectId, eventId: handoffEvent.id, uri: `memorygraph://handoff/${handoffId}`, kind: "manual" });
    this.database.recordHandoffGraph({
      handoffId,
      projectId: project.projectId,
      projectName: project.name,
      previousAgent,
      receivingAgent: input.receivingAgent,
      createdAt: contextWithoutHandoff.generatedAt,
      sourceEventId: handoffEvent.id,
    });
    return { ...contextWithoutHandoff, handoffId, estimatedTokens };
  }

  private ensureProjectNode(project: ProjectIdentity): void {
    this.database.upsertNode({
      id: projectNodeId(project.projectId),
      projectId: project.projectId,
      type: "Project",
      label: project.name,
      status: "active",
      summary: `Project ${project.name}`,
      attributes: { slug: project.slug, root: project.primaryRoot, workspaceId: project.workspaceId },
      validFrom: project.createdAt,
    });
  }

  private projectLatestAgentState(project: ProjectIdentity): string[] {
    const events = this.database.recentEvents(project.projectId, 500);
    const current = new Map(this.database.currentState(project.projectId, 500).map((entry) => [entry.key, entry]));
    const latestByAgent = new Map<string, (typeof events)[number]>();
    for (const event of events) {
      if (event.kind !== "message" || latestByAgent.has(event.agentId) || event.agentId === "manual") continue;
      latestByAgent.set(event.agentId, event);
    }
    const projected: string[] = [];
    for (const [agent, event] of latestByAgent) {
      const key = `agent.${agent}.last_activity`;
      if (current.get(key)?.sourceEventId !== event.id) {
        this.database.setState({
          projectId: project.projectId,
          key,
          value: { agent, summary: event.summary, occurredAt: event.occurredAt, sourceUri: event.sourceUri },
          valueText: event.summary,
          status: "active",
          validFrom: event.occurredAt,
          sourceEventId: event.id,
        });
      }
      const taskNode = `activity:${project.projectId}:${agent}`;
      this.database.upsertNode({
        id: taskNode,
        projectId: project.projectId,
        type: "Task",
        label: `${agent} latest activity`,
        status: "active",
        summary: event.summary,
        attributes: { agent, automaticallyProjected: true, sourceUri: event.sourceUri },
        validFrom: event.occurredAt,
        sourceEventId: event.id,
      });
      this.database.addEdge({
        id: `edge:project:${project.projectId}:${taskNode}:contains`,
        projectId: project.projectId,
        sourceNodeId: projectNodeId(project.projectId),
        targetNodeId: taskNode,
        type: "CONTAINS",
        validFrom: event.occurredAt,
        sourceEventId: event.id,
      });
      const agentNode = `agent:${agent}`;
      this.database.upsertNode({ id: agentNode, projectId: project.projectId, type: "Agent", label: agent, status: "active", attributes: { agentId: agent }, validFrom: event.occurredAt });
      this.database.addEdge({
        id: `edge:${taskNode}:${agentNode}:modified-by`,
        projectId: project.projectId,
        sourceNodeId: taskNode,
        targetNodeId: agentNode,
        type: "MODIFIED_BY",
        validFrom: event.occurredAt,
        sourceEventId: event.id,
      });
      projected.push(agent);
    }
    return projected;
  }
}
