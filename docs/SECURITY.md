# Security and privacy

## Defaults

- Bind the HTTP API to `127.0.0.1`.
- Keep raw events and current state in the user-selected local data directory.
- Treat Neo4j and Graphiti as optional projections, never as the only copy.
- Read agent sources without changing them.
- Redact credential-shaped keys and values before persistence.
- Preserve source evidence as locators; do not copy complete tool output or reasoning traces.
- Exclude internal Codex subagent/control sessions from user project memory while retaining an auditable exclusion marker in the raw store.

## Repository publication

- `.env` files, the generated `.memorygraph/` state directory, databases, logs, and backup files are excluded from version control.
- Keep `NEO4J_PASSWORD`, `GRAPHITI_API_KEY`, and provider credentials in the process environment or a secret manager. The Compose file intentionally requires `NEO4J_PASSWORD` instead of supplying a shared default.
- Before publishing, inspect both the working tree and Git history for user names, home-directory paths, credentials, private keys, session exports, and generated runtime state.
- Use placeholders such as `<project-path>` in documentation and fixtures; do not paste a workstation path into a tracked file.

## Trust boundaries

Agent session content is untrusted input. It can become evidence, but it cannot change MemoryGraph configuration, run commands, or authorize external transmission.

Graphiti enrichment may send event content to its configured language-model and embedding providers. Keep it disabled unless the operator has chosen those providers and accepts that data boundary. `add_memory` success is treated as queued, not durable; MemoryGraph verifies the episode appears before marking enrichment complete.

## Reversible installation

JSON agent configs are copied to timestamped `*.memorygraph-backup-*` files before mutation. Skill folders are renamed to timestamped backups before replacement and to `.removed-*` on uninstall. The service manager installs one user-scoped service definition and removes only that definition.
