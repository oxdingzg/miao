# Engine → product event bridge (design)

Design for the B1 facing layer (ADR-11 `handler-migration.md`): map the engine's
committed events onto the product session events the shell consumes, so a façade
handler can drive the engine and the TUI sees the same stream.

## Two vocabularies

Engine **committed** kinds (34): `run.started`, `run.finished`, `run.usage`,
`input.admitted`, `input.promoted`, `message.committed`, `tool.planned`,
`tool.dispatched`, `tool.completed`, `provider.started`, `provider.delta`,
`provider.failed`, `approval.requested`, `approval.resolved`, `context.changed`,
`context.inherited`, `history.compacted`, `session.forked`, `session.mode`,
`session.reverted`, `session.unreverted`, `session.state.updated`,
`loop.detected`, `job.*`, `cron.*`, `wakeup.*`, `hook.completed`,
`runtime.error`.

Product session events (44): `session.next.prompt.admitted`/`prompted`/
`prompt.cancelled`, `.step.started`/`step.ended`/`step.failed`,
`.text.started`/`text.delta`/`text.ended`, `.reasoning.*`, `.tool.input.*`,
`.tool.called`/`tool.progress`/`tool.success`/`tool.failed`,
`.command.*`, `.shell.*`, `.delegation.*`, `.revert.*`, `.compaction.*`,
`.context.updated`, `.agent.switched`, `.model.switched`, `.moved`,
`.info.updated`, `.notified`, `.synthetic`, `.failed`, `.retried`, plus
`session.status`/`session.idle`/`session.compacted`.

## Mapping buckets

1. **Session-id only (cheap).** `run.started` / `run.finished` →
   `session.status` / `session.idle`; `provider.failed` / failed `run.finished` →
   `session.next.failed`; `input.promoted` → `session.next.prompt.admitted`. Each
   still needs an exact product payload (a `StatusInfo`, a `Prompt`, a
   `SessionMessage.ID`), so "cheap" means the payload is small, not free.
2. **Needs id/location synthesis (the bulk).** `message.committed` → the
   `text.*` / `reasoning.*` / `tool.*` families; `tool.planned`/`dispatched`/
   `completed` → `tool.input.*` / `tool.called` / `tool.progress` / `tool.success`
   / `tool.failed`; `run.usage` → the `tokens`/`cost` on `step.ended`;
   `approval.requested` → the permission surface; `context.changed` →
   `context.updated`; `session.state.updated` (todos/goal) → plan/mode surface.
3. **Ephemeral (no committed engine event).** `text.delta`, `reasoning.delta`,
   `tool.input.delta`, `tool.progress`: the engine emits these only as ephemeral
   `progress` (never committed), so they bridge from `progress`, not the ledger.
4. **Product-only (no engine source).** `command.*`, `shell.*`, `delegation.*`,
   `revert.*`, `.moved`, `.info.updated`, `.notified`, `.synthetic`: the engine has
   no equivalent; under B1 these stay on the host (ADR-11 split), not bridged.

## The one open decision: id/location synthesis

Every event in bucket 2 (and most of bucket 1) carries a product identity the
engine event does not: `Location.Ref`, `SessionMessage.ID`, `Model.Ref`,
`ToolContent`. The engine has `session_id`, `run_id`, `call_id`/`provider_id`,
`seq`, the committed message projection, and usage — but not the product's
identity scheme.

So the bridge needs a synthesis layer mapping engine identity to product
identity, defined once:

- `session_id` → `Session.ID` (1:1; the façade adopts the engine session id).
- engine committed message (from `message.committed` / `history`) → product
  `SessionMessage.ID` (deterministic from `session_id` + the message seq/role).
- `call_id` / `provider_id` → tool `callID`; the tool_use `input` from the
  committed assistant projection.
- `run.usage` → `step.ended` `tokens`/`cost`; `Model.Ref` from the configured
  model.

This is the decision that unblocks implementation; it is a mapping, not a
protocol change.

## First implementation slice

1. Bucket 1 only, with exact payloads: `session.status` / `session.idle` /
   `session.next.failed` / `session.next.prompt.admitted`, plus
   `session.next.prompt.cancelled` on `cancel`.
2. Then the synthesis layer, then bucket 2 (message → text/tool, usage → step).
3. Bucket 3 bridges from `progress`; bucket 4 stays on the host.

The bridge is a pure translator (engine event + injected synthesis → zero or more
product events), so it is unit-testable with a stub synthesis and does not touch
the product event bus until a handler is wired.
