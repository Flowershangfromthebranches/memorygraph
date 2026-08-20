# MemoryGraph final product specification

## Product promise

MemoryGraph lets a person open any supported coding agent and say “continue”. The receiving agent pulls the latest evidence-backed project state, verifies it against the current repository, and resumes without requiring the previous agent to create a handoff.

The shared object is project state, not chat history. Native agent memories remain intact; MemoryGraph is the agent-independent public record for a project.

## Product pillars

1. **Project State, not only Memory** — current truth is distinct from historical facts and raw events.
2. **Handoff, not only Search** — resume compiles a bounded, task-ready context and records the transfer.
3. **Atlas, not only Viewer** — the UI explains what the whole workspace is doing, how projects relate, and which agent changed what.

## Final feature surface

### Memory Core

- Stable project UUIDs with multiple repository roots and move/clone resilience.
- Append-only raw event store for sessions, messages, tool calls, commands, file changes, commits, notes, and checkpoints.
- Controlled ontology: Workspace, Project, Workstream, Requirement, Task, Decision, Issue, Artifact, File, Commit, Concept, Agent, Session, Milestone, State, and Handoff.
- Temporal facts and state transitions with `valid_from`, `valid_to`, supersession, confidence, and source evidence.
- SQLite-backed source of truth, FTS search, replayable graph projection, optional Neo4j projection, and optional Graphiti semantic enrichment.
- Memory Diff between two points in time.

### Pull-based handoff

- Resolve the current project from `.memorygraph/project.json`, repository roots, or an explicit project ID.
- Incrementally sync the previous agent from a durable cursor.
- Reconcile claimed state with repository and Git evidence.
- Compile Level 0 identity, Level 1 current state, and Level 2 active work into a bounded context.
- Record what was inherited, why it was selected, token estimate, source agent, receiving agent, and subsequent outcome.

### Integrations

- Thin MemoryGraph Skill that maps “continue”, history, decision explanation, tracing, problem recall, and explicit remembering to a small MCP surface.
- MCP tools: `resume_project`, `search`, `remember`, `project_state`, `trace`, and `explain`.
- MCP resources for workspace, project state, decisions, issues, timeline, and handoffs.
- Read-only incremental adapters for Codex, OpenCode, Command Code, WorkBuddy, and Trae; adapters never extract credentials or cookies.
- CLI and local HTTP API for setup, sync, diagnostics, import/export, backup, and UI access.

### Visual console

- **Atlas** — projects as the workspace “neighborhood”, with cross-project relationships and activity/state signals.
- **Graph** — complete inspectable relationship network.
- **Tree** — a narrative primary hierarchy with reference branches for multi-parent relationships.
- **Timeline** — temporal state, decisions, events, and validity intervals.
- **Handoff** — agent-to-agent transfers, inherited context, and outcomes.
- Semantic zoom from workspace to project, workstream, task/decision/issue, then session/commit/file/agent.
- Agent Trail filtering, evidence Inspector, search, status legend, and Memory Diff.

### Desktop and operations

- Tauri desktop shell around the local React UI for macOS, Windows, and Linux.
- Local-only default binding, explicit data-directory controls, redaction rules, project-level exclusions, and auditable imports.
- Backup/restore and deterministic rebuild of projections from raw events.
- Installer/doctor flows for supported agents with reversible configuration changes.

## Completion gates

The goal is complete only when all of the following are true:

1. The full feature surface above exists in product code; documentation-only placeholders do not count.
2. A real Codex session and a real OpenCode session can be incrementally ingested without exposing credentials.
3. A receiving agent can call `resume_project` after the previous agent stops without an explicit commit and obtain repository-verified current state.
4. All five views render from the same temporal graph and expose source evidence.
5. SQLite replay, Neo4j projection, failure fallback, backup, and restore are tested.
6. MCP is exercised with a real stdio client and the HTTP/UI path is exercised in a real browser.
7. Desktop packages are built and smoke-tested on the available host; other platforms have reproducible CI builds.
8. Unit, integration, end-to-end, accessibility, performance, and recovery suites pass.

