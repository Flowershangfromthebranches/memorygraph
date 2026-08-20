# Adapter contracts

All adapters are read-only, incremental, source-specific, and cursor-backed. They emit sanitized events into the append-only store and attach a source locator without copying credentials.

| Adapter | Native source | Passive detail | Cursor |
|---|---|---|---|
| Codex | `~/.codex/sessions/**/*.jsonl` | Messages, tool calls/results, commands, file edits | byte offset per JSONL |
| OpenCode | `~/.local/share/opencode/opencode.db` | Messages, tool parts, commands, patches, checkpoints | `(part.time_updated, part.id)` |
| Command Code | `~/.commandcode/projects/**/*.jsonl` | Messages and content parts | byte offset per JSONL |
| WorkBuddy | `~/.workbuddy/projects/**/*.jsonl` | Messages, function calls/results, snapshots | byte offset per JSONL |
| Trae | workspace metadata + MCP live capture | Workspace activity only from passive storage | workspace mtime |

Trae’s native transcript store may be opaque or encrypted depending on the client build. MemoryGraph does not extract keys or reverse security boundaries. Full-detail Trae state is captured through the installed MCP + Skill while passive sync remains honest about its limitation.

## Project matching

An adapter accepts a session when its cwd is inside a registered project root. If a session starts in a parent workspace, Codex and WorkBuddy additionally require a direct reference to the project’s absolute root in that session file. This avoids assigning every workspace-level chat to every nested project.

## Redaction

Before persistence, recursively redact keys matching authorization, cookies, credentials, passwords, secrets, tokens, API keys, or private keys. Recognizable bearer and provider-token strings in text are also replaced. Tool outputs are represented by size and call identity rather than copied in full.
