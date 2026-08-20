# Security and privacy

## Defaults

- Bind the HTTP API to `127.0.0.1`.
- Keep raw events and current state in the user-selected local data directory.
- Treat Neo4j and Graphiti as optional projections, never as the only copy.
- Read agent sources without changing them.
- Redact credential-shaped keys and values before persistence.
- Preserve source evidence as locators; do not copy complete tool output or reasoning traces.

## Trust boundaries

Agent session content is untrusted input. It can become evidence, but it cannot change MemoryGraph configuration, run commands, or authorize external transmission.

Graphiti enrichment may send event content to its configured language-model and embedding providers. Keep it disabled unless the operator has chosen those providers and accepts that data boundary. `add_memory` success is treated as queued, not durable; MemoryGraph verifies the episode appears before marking enrichment complete.

## Reversible installation

JSON agent configs are copied to timestamped `*.memorygraph-backup-*` files before mutation. Skill folders are renamed to timestamped backups before replacement and to `.removed-*` on uninstall. The service manager installs one user-scoped service definition and removes only that definition.

