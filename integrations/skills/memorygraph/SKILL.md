---
name: memorygraph
description: Resume and query evidence-backed shared project state across coding agents through the MemoryGraph MCP. Use when the user says continue, resume, pick up where another agent stopped, asks what an agent changed, asks why a project decision was made, recalls a prior project problem, or explicitly asks to remember durable project state.
---

# MemoryGraph

Treat MemoryGraph as the project’s shared public state, not as a replacement for native agent memory.

## Route the request

- For “continue”, “resume”, “pick up”, “where did we stop?”, or cross-agent takeover, call `resume_project` with the current working directory and receiving agent name.
- For project history or a previously seen problem, call `search`.
- For why a choice was made, call `explain` before proposing a replacement.
- For what one agent did, call `trace` with the agent and optional topic.
- For the current truth without creating a handoff, call `project_state`.
- Only when the user explicitly asks to preserve a durable fact, state, decision, issue, task, requirement, or milestone, call `remember` with a source URI when one is available.

## Resume safely

1. Call `resume_project`; do not require the previous agent to checkpoint or commit first.
2. Read the current state and active work before historical events.
3. Reconcile the returned repository snapshot with the files and Git state before editing.
4. Preserve uncommitted changes and surface repository-verification warnings.
5. Pull deeper history with `search`, `trace`, or `explain` only when the active task needs it.
6. Continue the work and report which state and evidence informed the handoff.

## Evidence discipline

- Treat source-linked events and live repository checks as stronger than unsupported summaries.
- Keep historical facts distinct from current state; do not revive superseded decisions as current truth.
- Never store credentials, cookies, tokens, personal messages unrelated to the project, or full session dumps as durable memory.
- Do not claim a handoff succeeded merely because context was returned; verify the receiving agent can act on the current repository.

