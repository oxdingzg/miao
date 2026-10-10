# Engine → product facade mapping

Reference table for the compatibility facade that lets the TS runtime/TUI run a
Session on the Rust engine (ADR-11 client contract; ADR-08 sidecar phase). The
facade owns the mapping; this file records the engine-side names it maps from so
both sides agree. It is engine-authored metadata, not a product spec.

## Tool names

The TUI renders tool parts; the engine's tool names differ, so the facade maps
each engine tool to the product tool id whose renderer already exists. Unknown or
external tools fall back to a generic/plugin renderer.

| Engine tool | Product tool id |
|---|---|
| `read_file` | `read` |
| `list_files` | `read` (directory listing) |
| `glob` | `glob` |
| `grep` | `grep` |
| `write_file` | `write` |
| `edit_file` | `edit` |
| `apply_patch` | `apply-patch` |
| `run_command`, `bash` | `bash` |
| `start_job`, `job_status`, `cancel_job` | `background-job` |
| `task` | `task` |
| `todowrite` | `todowrite` |
| `goal` | `goal` |
| `question` | `question` |
| `recall` | `recall` |
| `session_state` | state (generic) |
| `schedule_wakeup`, `cancel_wakeup`, `cron_*` | `schedule` |
| `lsp_diagnostics`, `lsp_definition`, `lsp_references` | `lsp` |
| `worker__*`, MCP aliases | `custom` / `plugin-tool` (generic) |

The tool *input schema* is the engine's; the facade translates input/output to
the product part shape. `tool.completed` carries the engine result; the facade
must present it as the product tool-result part (success/error, bounded output).

## Event mapping

Engine durable events → product `session.next.*` / message parts. `provider.delta`
is the ephemeral streaming lane (assistant text/reasoning increments).

| Engine event | Product |
|---|---|
| `input.promoted` | `session.next.prompted` / user message |
| `message.committed` (user) | user message part |
| `message.committed` (assistant) | assistant text/reasoning part (see #560) |
| `provider.delta` | assistant text/reasoning streamed delta |
| `tool.planned` | tool part created (name mapped per above) |
| `tool.dispatched` | tool part running |
| `tool.completed` | tool result part |
| `approval.requested` / `approval.resolved` | permission prompt / decision |
| `question.requested` | question prompt |
| `run.started` / `run.finished` | `session.next.status` busy / idle (#555) |
| `run.usage` | turn usage/cost |
| `session.reverted` / `session.unreverted` | rewind / restore |
| `session.forked`, `session.mode`, `history.compacted` | forked / mode / compaction |

## Attach / replay / resume

- `snapshot` returns session, epoch, durable cursor, messages and outstanding
  requests: render history from it, then `subscribe(after = cursor)` to replay up
  to the watermark and continue live. A cursor too old to replay is the resync
  path (ADR-03).
- `resume`, `fork`, `revert`, `unrevert`, `compact` are engine commands the
  facade maps from the product equivalents.

## Approvals and questions

`approval.requested` carries `{request_id, input_hash, policy_revision, scope,
expiry}`; the answer must echo `request_id`, `input_hash`, `policy_revision` so a
stale or replayed answer cannot authorize a mutated action (ADR-04). `question`
answers are bound the same way. The facade must not apply the decision locally
without sending it to the engine.

## Credentials and config

Per ADR-09 the TS runtime stays the sole refresh owner in the sidecar phase; the
engine reads the V2 credential database (or the legacy file) read-only and fails
with `credential is expired; its owning broker must refresh it`. The facade maps
the product's model/provider/permission/agent and LSP/MCP/skills/references
config into the engine's `--model/--provider/--policy/--lsp-config/--mcp-config/--skills-config/--references-config`.
