# Architecture

```text
Codex  OpenCode  Command Code  WorkBuddy  Trae
  │       │           │            │        │
  └───────┴───────────┴────────────┴────────┘
              adapters + Skill/MCP
                       │
                Memory Gateway
                       │
  Project Resolver ─ Session Sync ─ Handoff Engine
                       │
       Retrieval ─ Context Compiler ─ Memory Diff
                       │
     ┌─────────────────┼──────────────────┐
     │                 │                  │
 Event/State       Search index      Graph projection
 SQLite + FTS5         FTS5          SQLite / Neo4j
     │                                    │
     └──────────── replay bus ────────────┘
                                          │
                             optional Graphiti enrichment

              Atlas / Graph / Tree / Timeline / Handoff
                             React + Tauri
```

## Authority boundaries

- Raw events are append-only and are the replay authority.
- Current state is a materialized projection with explicit evidence and temporal validity.
- The graph is a projection and can be rebuilt; Neo4j and Graphiti never become the only copy of user data.
- Adapters are read-only. MemoryGraph writes only its own store and explicit per-project identity files.
- Agent-facing context is bounded and layered. A resume never dumps complete sessions into the context window.

## Delivery order

Implementation proceeds as vertical slices so every stage remains runnable, but the final goal is the complete product described in `PRODUCT_SPEC.md`, not the first slice.

