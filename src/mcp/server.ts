import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";

import { MemoryGraphCore } from "../core/memorygraph-core.js";

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value && typeof value === "object" ? value as Record<string, unknown> : { value },
  };
}

export function buildMcpServer(core: MemoryGraphCore): McpServer {
  const server = new McpServer(
    { name: "memorygraph", version: "0.1.0" },
    {
      instructions: "MemoryGraph is the evidence-backed shared project state. For continue/resume/cross-agent takeover, call resume_project first with cwd and the receiving agent; trust current state and live repository evidence before historical events. Use search/trace/explain for deeper context. Store durable facts only when explicitly requested. Never store credentials, cookies, tokens, or unrelated private content.",
    },
  );

  server.registerTool(
    "resume_project",
    {
      title: "Resume project",
      description: "Pull and compile the latest shared project state for a receiving agent. Use for continue, resume, handoff, or picking up another agent's work.",
      inputSchema: z.object({
        cwd: z.string().min(1).optional().describe("Current project directory"),
        project_id: z.string().min(1).optional().describe("Explicit registered project UUID when cwd is unavailable"),
        receiving_agent: z.string().min(1).describe("Agent receiving the handoff, for example codex or opencode"),
        token_budget: z.number().int().min(400).max(8_000).default(1_500),
      }).refine((value) => Boolean(value.cwd || value.project_id), { message: "cwd or project_id is required" }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ cwd, project_id, receiving_agent, token_budget }) => result(project_id
      ? core.resumeProjectById({ projectId: project_id, receivingAgent: receiving_agent, tokenBudget: token_budget })
      : core.resumeProject({ cwd: cwd!, receivingAgent: receiving_agent, tokenBudget: token_budget })),
  );

  server.registerTool(
    "search",
    {
      title: "Search project memory",
      description: "Search evidence-backed events and graph nodes within the current project.",
      inputSchema: z.object({
        cwd: z.string().min(1),
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ cwd, query, limit }) => result(core.search(cwd, query, limit)),
  );

  server.registerTool(
    "remember",
    {
      title: "Remember project fact",
      description: "Record an explicit long-lived project fact, state, decision, issue, task, requirement, milestone, or note with provenance.",
      inputSchema: z.object({
        cwd: z.string().min(1),
        agent: z.string().min(1),
        kind: z.enum(["fact", "state", "decision", "issue", "task", "requirement", "milestone", "note"]),
        title: z.string().min(1).max(500),
        content: z.string().min(1).max(20_000),
        key: z.string().min(1).max(500).optional(),
        value: z.unknown().optional(),
        status: z.enum(["planned", "active", "blocked", "complete", "deprecated"]).default("active"),
        source_uri: z.string().min(1).optional(),
        session_id: z.string().min(1).optional(),
        confidence: z.number().min(0).max(1).default(1),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => result(core.remember({
      cwd: input.cwd,
      agent: input.agent,
      kind: input.kind,
      title: input.title,
      content: input.content,
      ...(input.key === undefined ? {} : { key: input.key }),
      ...(input.value === undefined ? {} : { value: input.value }),
      status: input.status,
      ...(input.source_uri === undefined ? {} : { sourceUri: input.source_uri }),
      ...(input.session_id === undefined ? {} : { sessionId: input.session_id }),
      confidence: input.confidence,
    })),
  );

  server.registerTool(
    "project_state",
    {
      title: "Get current project state",
      description: "Return current state, active work, recent decisions, and a live Git snapshot without creating a handoff.",
      inputSchema: z.object({ cwd: z.string().min(1).optional(), project_id: z.string().min(1).optional() })
        .refine((value) => Boolean(value.cwd || value.project_id), { message: "cwd or project_id is required" }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ cwd, project_id }) => result(project_id ? core.projectStateById(project_id) : core.projectState(cwd!)),
  );

  server.registerTool(
    "trace",
    {
      title: "Trace agent work",
      description: "Trace evidence-backed work performed by one agent, optionally filtered to a topic.",
      inputSchema: z.object({
        cwd: z.string().min(1),
        agent: z.string().min(1),
        topic: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ cwd, agent, topic, limit }) => result(core.trace(cwd, agent, topic, limit)),
  );

  server.registerTool(
    "explain",
    {
      title: "Explain a project decision",
      description: "Find the decisions and source events that explain why the project reached its current state.",
      inputSchema: z.object({
        cwd: z.string().min(1),
        question: z.string().min(1),
        limit: z.number().int().min(1).max(30).default(8),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ cwd, question, limit }) => result(core.explain(cwd, question, limit)),
  );

  server.registerResource(
    "workspace",
    "memory://workspace",
    { title: "MemoryGraph workspace", description: "All registered projects", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(core.database.listProjects(), null, 2) }] }),
  );

  server.registerResource(
    "project-state",
    new ResourceTemplate("memory://project/{projectId}/state", { list: undefined }),
    { title: "Project state", description: "Current materialized state for a project", mimeType: "application/json" },
    async (uri, variables) => {
      const projectId = String(variables.projectId);
      const project = core.database.getProject(projectId);
      const payload = project ? { project, state: core.database.currentState(projectId), activeWork: core.database.activeNodes(projectId), facts: core.database.listFacts(projectId) } : { error: "project_not_found", projectId };
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }] };
    },
  );

  server.registerResource(
    "project-decisions",
    new ResourceTemplate("memory://project/{projectId}/decisions", { list: undefined }),
    { title: "Project decisions", description: "Current and historical project decisions", mimeType: "application/json" },
    async (uri, variables) => {
      const projectId = String(variables.projectId);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ project: core.database.getProject(projectId), decisions: core.database.recentDecisions(projectId, 200) }, null, 2) }] };
    },
  );

  server.registerResource(
    "project-issues",
    new ResourceTemplate("memory://project/{projectId}/issues", { list: undefined }),
    { title: "Project issues", description: "Active and blocked issue nodes", mimeType: "application/json" },
    async (uri, variables) => {
      const projectId = String(variables.projectId);
      const issues = core.database.activeNodes(projectId, 500).filter((node) => node.type === "Issue");
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ project: core.database.getProject(projectId), issues }, null, 2) }] };
    },
  );

  server.registerResource(
    "project-timeline",
    new ResourceTemplate("memory://project/{projectId}/timeline", { list: undefined }),
    { title: "Project timeline", description: "Evidence-backed project events ordered by occurrence", mimeType: "application/json" },
    async (uri, variables) => {
      const projectId = String(variables.projectId);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ project: core.database.getProject(projectId), events: core.database.recentEvents(projectId, 500) }, null, 2) }] };
    },
  );

  server.registerResource(
    "project-handoffs",
    new ResourceTemplate("memory://project/{projectId}/handoffs", { list: undefined }),
    { title: "Project handoffs", description: "Agent-to-agent handoff records and outcomes", mimeType: "application/json" },
    async (uri, variables) => {
      const projectId = String(variables.projectId);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ project: core.database.getProject(projectId), handoffs: core.database.listHandoffs(projectId, 200) }, null, 2) }] };
    },
  );

  return server;
}
