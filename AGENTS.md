# MemoryGraph engineering rules

- Treat raw events as append-only authority. State, FTS, SQLite graph, Neo4j, and Graphiti are replayable projections.
- Keep adapters read-only. Never extract browser cookies, credentials, encryption keys, or opaque-store secrets.
- Do not claim a handoff succeeded because context was generated; verify the receiving transport can act on the current repository.
- Keep the public MCP surface small. Add internal APIs before adding new agent-facing tools.
- Distinguish source implementation, automated tests, runtime validation, cross-agent acceptance, and final product completion.
- Preserve uncommitted work reported by repository verification.
- Never complete the project goal at a milestone. Use `docs/PRODUCT_SPEC.md` completion gates.

