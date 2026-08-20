export interface ProjectionReport {
  backend: string;
  projectId: string;
  nodes: number;
  edges: number;
  startedAt: string;
  completedAt: string;
}

export interface GraphProjection {
  readonly id: string;
  verify(): Promise<void>;
  rebuildProject(projectId: string): Promise<ProjectionReport>;
  close(): Promise<void>;
}

