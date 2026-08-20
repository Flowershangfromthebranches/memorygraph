export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id, last_active_at DESC);

  CREATE TABLE IF NOT EXISTS project_roots (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    root_path TEXT NOT NULL UNIQUE,
    root_fingerprint TEXT NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, root_path)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    cwd TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    source_uri TEXT NOT NULL,
    last_cursor TEXT,
    summary TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    UNIQUE(agent_id, external_id)
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_project_time ON sessions(project_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    source_uri TEXT NOT NULL,
    source_offset TEXT,
    dedupe_key TEXT NOT NULL UNIQUE,
    summary TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0
  );
  CREATE INDEX IF NOT EXISTS idx_events_project_time ON events(project_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS idx_events_agent_time ON events(agent_id, occurred_at DESC);

  CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    uri TEXT NOT NULL,
    kind TEXT NOT NULL,
    locator_json TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    digest TEXT,
    UNIQUE(event_id, uri)
  );

  CREATE TABLE IF NOT EXISTS state_entries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    value_text TEXT NOT NULL,
    status TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    source_event_id TEXT NOT NULL REFERENCES events(id),
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_state_current_key
    ON state_entries(project_id, key) WHERE valid_to IS NULL;
  CREATE INDEX IF NOT EXISTS idx_state_history ON state_entries(project_id, key, valid_from DESC);

  CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    rationale TEXT NOT NULL,
    status TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    supersedes_id TEXT REFERENCES decisions(id),
    event_id TEXT NOT NULL REFERENCES events(id)
  );
  CREATE INDEX IF NOT EXISTS idx_decisions_project_time ON decisions(project_id, decided_at DESC);

  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NOT NULL,
    attributes_json TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    source_event_id TEXT REFERENCES events(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_nodes_project_type ON nodes(project_id, type, status);

  CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    attributes_json TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    source_event_id TEXT REFERENCES events(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_edges_project_type ON edges(project_id, type, status);
  CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_node_id, valid_to);
  CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_node_id, valid_to);

  CREATE TABLE IF NOT EXISTS handoffs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    previous_agent TEXT,
    receiving_agent TEXT NOT NULL,
    created_at TEXT NOT NULL,
    context_json TEXT NOT NULL,
    inherited_event_ids_json TEXT NOT NULL,
    estimated_tokens INTEGER NOT NULL,
    outcome_status TEXT NOT NULL DEFAULT 'pending',
    outcome_summary TEXT,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_handoffs_project_time ON handoffs(project_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS sync_cursors (
    adapter_id TEXT NOT NULL,
    source_key TEXT NOT NULL,
    cursor_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    error TEXT,
    PRIMARY KEY(adapter_id, source_key)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
    event_id UNINDEXED,
    project_id UNINDEXED,
    summary,
    payload,
    tokenize='unicode61 remove_diacritics 2'
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    node_id UNINDEXED,
    project_id UNINDEXED,
    label,
    summary,
    tokenize='unicode61 remove_diacritics 2'
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS project_privacy_policies (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    store_message_content INTEGER NOT NULL DEFAULT 1,
    max_message_chars INTEGER NOT NULL DEFAULT 4000,
    excluded_paths_json TEXT NOT NULL DEFAULT '[".env","credentials",".ssh","secrets"]',
    updated_at TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE events ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE events ADD COLUMN excluded_reason TEXT;
  CREATE INDEX IF NOT EXISTS idx_events_project_included_time ON events(project_id, excluded, occurred_at DESC);
  `,
];
