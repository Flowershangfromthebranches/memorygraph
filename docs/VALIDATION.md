# Validation model

MemoryGraph reports evidence in separate lanes:

1. **Source implementation** — product code and schemas exist.
2. **Automated validation** — unit and integration suites pass.
3. **Runtime validation** — real stdio, HTTP, browser, Neo4j, or desktop processes run.
4. **Cross-agent acceptance** — a receiving agent transport pulls current state after another agent stops.
5. **Final product completion** — every gate in `PRODUCT_SPEC.md` passes.

Current reproducible checks:

- `npm test` covers temporal facts/state, strict handoff budgets, graph replay/slicing, handoff outcomes, backup, HTTP security, MCP, five adapter formats, multi-root identity, and reversible installers.
- `npm run verify:stdio` spawns the built stdio server, lists all six tools, calls `resume_project`, and reports the handoff ID and budget.
- `npm run verify:opencode-adapter` uses a real OpenCode SQLite source and confirms second-sync idempotency without printing message contents.
- `NEO4J_TEST=1 ... vitest` rebuilds a real Neo4j projection, independently queries counts, and cleans its test graph.
- `npm run desktop:build -- --bundles app` creates a platform bundle. Runtime UI behavior must still be visually inspected on the host.
- The recovery E2E stops the installed Core, isolates the database plus WAL/SHM, restores an online backup, restarts the service, and compares integrity plus project/event/state/handoff counts.
