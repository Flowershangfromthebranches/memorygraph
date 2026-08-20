export type ViewMode = "atlas" | "graph" | "tree" | "timeline" | "handoff";

export interface Project {
  projectId: string;
  workspaceId: string;
  name: string;
  slug: string;
  primaryRoot: string;
  createdAt: string;
}

export interface GraphNode {
  id: string;
  projectId: string;
  type: string;
  label: string;
  status: string;
  summary: string;
  attributes: Record<string, unknown>;
  validFrom: string;
  validTo: string | null;
  sourceEventId: string | null;
}

export interface GraphEdge {
  id: string;
  projectId: string;
  source: string;
  target: string;
  type: string;
  status: string;
  attributes: Record<string, unknown>;
  validFrom: string;
  validTo: string | null;
  sourceEventId: string | null;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalNodes?: number;
  totalEdges?: number;
  truncated?: boolean;
}

export interface TimelineEvent {
  id: string;
  agentId: string;
  kind: string;
  summary: string;
  occurredAt: string;
  sourceUri: string;
}

export interface Handoff {
  id: string;
  previousAgent: string | null;
  receivingAgent: string;
  createdAt: string;
  estimatedTokens: number;
  inheritedEventIds: string[];
  outcomeStatus: string;
  outcomeSummary: string | null;
  completedAt: string | null;
  context: Record<string, unknown>;
}

export interface StateEntry {
  key: string;
  value: unknown;
  valueText: string;
  status: string;
  validFrom: string;
  sourceEventId: string;
}

export interface Decision {
  id: string;
  title: string;
  rationale: string;
  decidedAt: string;
}

export interface ProjectState {
  project: Project;
  state: StateEntry[];
  activeWork: Array<{ id: string; type: string; label: string; status: string; summary: string }>;
  facts: Array<{ id: string; predicate: string; objectText: string; confidence: number; validFrom: string }>;
  decisions: Decision[];
}

export interface Evidence {
  id: string | null;
  uri: string | null;
  kind: string | null;
  capturedAt: string | null;
  event: { id: string; agentId: string; kind: string; summary: string; occurredAt: string };
}

export interface MemoryDiff {
  from: string;
  to: string;
  added: Array<StateEntry & { validTo: string | null }>;
  removed: Array<StateEntry & { validTo: string | null }>;
  changed: Array<{ key: string; before: StateEntry; after: StateEntry }>;
}
