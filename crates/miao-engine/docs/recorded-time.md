# Durable recording time

Engine events and message projections expose `recorded_at_ms`: UNIX milliseconds captured when the source event is committed. User promotion, direct message commits, assistant replies, and tool-result projections persist the exact same value in their event and message rows. History, snapshots, subscription replay, and JSONL exports read stored values rather than sampling the observation clock.

Schema 11 adds nullable columns to `engine_event` and `engine_message`. Existing rows remain `NULL`, serialized as `recorded_at_ms: null`; consumers must treat that as unknown. Read-only exports of unmigrated stores also emit null and do not mutate the store. No historical creation time is synthesized during migration.

Forked messages retain their source recording time, including unknown legacy times. Their copied `message.committed` events carry the same source time; this is the original message recording time, not the time the fork operation occurred. The separate `session.forked` event records the fork operation's commit time. Synthetic provider context messages have no durable recording time.

## Historical model identity

`Provider.identity()` currently reports protocol/model identity, and routing can expose the selected provider identity. This identity is not yet persisted by the runtime: `run.started` carries only `run_id`, and `message.committed` contains no complete model/provider/agent identity. Some provider-opaque content includes a model, but it is protocol-specific and does not establish identity for all messages or fallback turns.

Product projections must not apply the current configuration retroactively as historical identity. Persisting the actual selected provider-turn identity, including fallback routing, remains a separate integration requirement.

## Verification

`tests/recorded_time.rs` checks shared event/message times across promotion and assistant commit paths, stable replay/reopen/snapshot/export, preservation on fork, nullable legacy migration, and read-only export before migration.
