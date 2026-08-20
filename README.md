# MemoryGraph

MemoryGraph is a local-first shared project-state layer for coding agents. It lets a receiving agent pull the latest evidence-backed state and continue from another agent without requiring the previous agent to create a handoff.

The product is built around three distinctions:

- **Project State, not only Memory** — current truth is separate from raw history.
- **Handoff, not only Search** — “continue” compiles bounded, task-ready context.
- **Atlas, not only Viewer** — five views explain the workspace, project, timeline, and agent trail.

## What is implemented

- SQLite event/state store, temporal validity, FTS5 search, evidence, controlled graph ontology, and Memory Diff.
- Pull-based project resolution, repository verification, layered context compiler, and handoff outcomes.
- Six-tool MCP surface plus project resources over stdio.
- Incremental passive adapters for Codex, OpenCode, Command Code, and WorkBuddy; safe workspace-level observation plus live MCP capture for Trae’s opaque native transcript store.
- Atlas, Graph, Narrative Tree, Timeline, Handoff, Agent Trail, search, and Inspector UI.
- Replayable Neo4j projection and optional verified Graphiti enrichment.
- Tauri 2 desktop shell, reversible multi-agent integration installer, service manager, backup, and restore.

The project goal is the complete feature set in [PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md). Early milestones are not treated as final completion.

## Quick start

Requirements: Node.js 22.5 or newer. Neo4j and Rust are optional unless you use graph projection or build the desktop app.

```bash
npm install
npm run build
node dist/cli.js init /path/to/project --name "My Project"
node dist/cli.js serve
```

Open [http://127.0.0.1:4765](http://127.0.0.1:4765).

Record explicit state:

```bash
node dist/cli.js remember /path/to/project \
  --agent codex \
  --kind state \
  --title "Current database" \
  --content "SQLite with a Neo4j projection" \
  --key database \
  --value '"sqlite+neo4j"'
```

Pull a handoff:

```bash
node dist/cli.js resume /path/to/project --agent opencode --token-budget 1500
```

## Agent integration

Preview status, then install MCP + Skill entries. Existing JSON configurations are backed up before mutation; removals preserve recoverable Skill copies.

```bash
node dist/cli.js integration status --agent all
node dist/cli.js integration install --agent all
node dist/cli.js integration uninstall --agent opencode
```

Supported agent names: `codex`, `opencode`, `command-code`, `workbuddy`, and `trae`.

Install the Core as a per-user background service:

```bash
node dist/cli.js service install
node dist/cli.js service status
node dist/cli.js service uninstall
```

## MCP

Run the server:

```bash
node dist/cli.js mcp
```

Tools:

- `resume_project`
- `search`
- `remember`
- `project_state`
- `trace`
- `explain`

Resources cover the workspace plus project state, decisions, issues, timeline, and handoffs.

## Neo4j and Graphiti

SQLite remains authoritative. Neo4j and Graphiti are disposable projections.

```bash
docker compose up -d neo4j
NEO4J_PASSWORD=memorygraph-local node dist/cli.js project-neo4j /path/to/project
```

Set `GRAPHITI_URL` to a Graphiti MCP HTTP endpoint to use semantic enrichment. MemoryGraph assigns each project UUID as Graphiti `group_id`, passes event occurrence time, and verifies the episode is observable after `add_memory`; a queued response alone is never accepted as success.

## Desktop

```bash
npm run desktop:dev
npm run desktop:build -- --bundles app
```

The Tauri console connects to the loopback Core at `127.0.0.1:4765`. Install the Core service first for normal desktop use.

## Validation

```bash
npm run validate
npm run verify:stdio -- /path/to/project /path/to/data opencode
npm run verify:opencode-adapter -- /path/from/a/real/opencode/session /path/to/opencode.db
NEO4J_TEST=1 NEO4J_PASSWORD=memorygraph-local npx vitest run tests/neo4j.integration.test.ts
```

See [VALIDATION.md](docs/VALIDATION.md) for the evidence categories and [SECURITY.md](docs/SECURITY.md) for privacy boundaries.

