export const NODE_TYPES = [
  "Workspace",
  "Project",
  "Workstream",
  "Requirement",
  "Task",
  "Decision",
  "Issue",
  "Artifact",
  "File",
  "Commit",
  "Concept",
  "Agent",
  "Session",
  "Milestone",
  "State",
  "Handoff",
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

export const EDGE_TYPES = [
  "CONTAINS",
  "DEPENDS_ON",
  "RELATES_TO",
  "IMPLEMENTS",
  "BLOCKS",
  "RESOLVES",
  "SUPERSEDES",
  "PRODUCED_BY",
  "MODIFIED_BY",
  "DECIDED_IN",
  "CONTINUES",
  "DERIVED_FROM",
  "SHARED_WITH",
  "CHANGES",
  "EVIDENCED_BY",
] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];
export type EntityStatus = "planned" | "active" | "blocked" | "complete" | "deprecated";

export const EVENT_KINDS = [
  "session",
  "message",
  "tool_call",
  "command",
  "file_change",
  "git_commit",
  "checkpoint",
  "memory",
  "state_change",
  "decision",
  "issue",
  "handoff",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export interface ProjectIdentity {
  projectId: string;
  workspaceId: string;
  name: string;
  slug: string;
  primaryRoot: string;
  createdAt: string;
}

export interface MemoryEventInput {
  projectId: string;
  agentId: string;
  sessionId?: string;
  kind: EventKind;
  occurredAt?: string;
  sourceUri: string;
  sourceOffset?: string;
  dedupeKey: string;
  summary: string;
  payload?: Record<string, unknown>;
  confidence?: number;
}

export interface MemoryEvent extends Required<Omit<MemoryEventInput, "sessionId" | "sourceOffset" | "payload" | "occurredAt" | "confidence">> {
  id: string;
  sessionId: string | null;
  sourceOffset: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
  ingestedAt: string;
  confidence: number;
}

export interface EvidenceInput {
  projectId: string;
  eventId: string;
  uri: string;
  kind: "conversation" | "file" | "git" | "tool" | "manual" | "adapter";
  locator?: Record<string, unknown>;
  digest?: string;
}

export interface StateInput {
  projectId: string;
  key: string;
  value: unknown;
  valueText: string;
  status?: EntityStatus;
  validFrom?: string;
  sourceEventId: string;
}

export interface GraphNodeInput {
  id?: string;
  projectId: string;
  type: NodeType;
  label: string;
  status?: EntityStatus;
  summary?: string;
  attributes?: Record<string, unknown>;
  validFrom?: string;
  validTo?: string | null;
  sourceEventId?: string;
}

export interface GraphEdgeInput {
  id?: string;
  projectId: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: EdgeType;
  status?: EntityStatus;
  attributes?: Record<string, unknown>;
  validFrom?: string;
  validTo?: string | null;
  sourceEventId?: string;
}

export interface SearchHit {
  id: string;
  kind: "event" | "node" | "state" | "decision" | "issue";
  title: string;
  snippet: string;
  score: number;
  occurredAt: string;
  sourceUri?: string;
}

export interface RepositorySnapshot {
  root: string;
  isGitRepository: boolean;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  changedFiles: string[];
  capturedAt: string;
  error?: string;
}

export interface ResumeContext {
  project: ProjectIdentity;
  receivingAgent: string;
  previousAgent: string | null;
  generatedAt: string;
  repository: RepositorySnapshot;
  currentState: Array<{
    key: string;
    value: unknown;
    valueText: string;
    status: EntityStatus;
    validFrom: string;
    sourceEventId: string;
  }>;
  activeWork: Array<{
    id: string;
    type: NodeType;
    label: string;
    status: EntityStatus;
    summary: string;
  }>;
  recentDecisions: Array<{
    id: string;
    title: string;
    rationale: string;
    decidedAt: string;
  }>;
  recentEvents: Array<{
    id: string;
    agentId: string;
    kind: EventKind;
    summary: string;
    occurredAt: string;
    sourceUri: string;
  }>;
  sync: AdapterSyncResult[];
  nextSteps: string[];
  handoffId: string;
  estimatedTokens: number;
  warnings: string[];
}

export interface AdapterSyncResult {
  adapterId: string;
  sourceKey: string;
  scanned: number;
  ingested: number;
  skipped: number;
  cursor: Record<string, unknown>;
  warnings: string[];
}

export interface ProjectPrivacyPolicy {
  projectId: string;
  storeMessageContent: boolean;
  maxMessageChars: number;
  excludedPathPatterns: string[];
  updatedAt: string;
}
