import type { Evidence, GraphData, Handoff, MemoryDiff, Project, ProjectState, TimelineEvent } from "./types";

const API_BASE = window.location.protocol === "tauri:" || window.location.hostname === "tauri.localhost"
  ? "http://127.0.0.1:4765"
  : "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  const payload = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? `${response.status} ${response.statusText}`);
  return payload;
}

export const api = {
  sync: () => request<{ projects: unknown[] }>("/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
  projects: () => request<{ projects: Project[] }>("/api/projects"),
  graph: (projectId?: string) => request<GraphData>(`/api/graph${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  state: (projectId: string) => request<ProjectState>(`/api/projects/${encodeURIComponent(projectId)}/state`),
  events: (projectId: string) => request<{ project: Project; events: TimelineEvent[] }>(`/api/projects/${encodeURIComponent(projectId)}/timeline`),
  handoffs: (projectId: string) => request<{ project: Project; handoffs: Handoff[] }>(`/api/projects/${encodeURIComponent(projectId)}/handoffs`),
  evidence: (nodeId: string) => request<{ evidence: Evidence[] }>(`/api/nodes/${encodeURIComponent(nodeId)}/evidence`),
  diff: (projectId: string, from: string, to: string) => request<MemoryDiff>(`/api/projects/${encodeURIComponent(projectId)}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  resume: (cwd: string, receivingAgent: string) => request<Record<string, unknown>>("/api/resume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd, receiving_agent: receivingAgent, token_budget: 1_500 }),
  }),
  search: (cwd: string, query: string) => request<{ hits: Array<Record<string, unknown>> }>("/api/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd, query, limit: 20 }),
  }),
};
