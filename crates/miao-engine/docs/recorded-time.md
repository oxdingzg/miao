# Durable recording time

Engine events and message projections expose `recorded_at_ms`: UNIX milliseconds captured when the source event is committed. User promotion, direct message commits, assistant replies, and tool-result projections persist the exact same value in their event and message rows. History, snapshots, subscription replay, and JSONL exports read stored values rather than sampling the observation clock.

Schema 11 adds nullable columns to `engine_event` and `engine_message`. Existing rows remain `NULL`, serialized as `recorded_at_ms: null`; consumers must treat that as unknown. Read-only exports of unmigrated stores also emit null and do not mutate the store. No historical creation time is synthesized during migration.

Forked messages retain their source recording time, including unknown legacy times. Their copied `message.committed` events carry the same source time; this is the original message recording time, not the time the fork operation occurred. The separate `session.forked` event records the fork operation's commit time. Synthetic provider context messages have no durable recording time.

## Product delivery bridge

The TypeScript engine client carries `recorded_at_ms` through the Session bridge as `source.recordedAtMs` and into the client envelope as `metadata.engine.recorded_at_ms`. Missing fields from older sidecars normalize to null. The envelope ID remains based on the authoritative store, Session, cursor, event type, and per-type index; recording time does not change delivery identity.

For known recording times, bridged prompt, text, tool-call, tool-result, and lifecycle timestamps use the stored value, including epoch zero. Legacy events still require a timestamp for the existing product delivery contract, so that field uses the observation clock while source metadata remains null. Consumers must treat it as delivery time, never as historical message creation time. A complete historical projection must preserve unknown time explicitly. Client delivery does not write these events into the TypeScript durable journal.

## Historical model identity

Successful runtime replies now commit a separate `assistant.identity` event in the same transaction as the assistant message and tool dispatch intents. It binds `assistant_seq`, `run_id`, and provider `step` to the reply's actual protocol/model identity. Its recording time matches the assistant commit. Unknown custom-provider identities and agent manifests remain explicit null.

`Provider.reply_identity(reply)` is the authority for a successful turn. A direct provider reports its configured identity; the fallback adapter reports its own selected-route identity, including opaque-history pinning. Provider-reported usage is nested under `reported` and cannot impersonate the adapter's routing selection. `Provider.identity()` alone reports the initial configured route and must not be applied to fallback replies.

Snapshots attach this evidence as `messages[].identity`. Forks preserve it with a rebased `assistant_seq` and an explicit source `origin`; ledger replay, reopen, and JSONL export retain the evidence. The model-input `history` vocabulary remains role/content/checkpoint/time, so provenance does not enter provider message bodies. Legacy messages and partial replies without successful identity evidence stay unknown; consumers must not borrow the current configuration or a later turn's identity. Product catalog provider IDs and complete agent manifests are not established by a protocol/model pair.

## Verification

`tests/routing.rs` checks actual HTTP fallback identity, runtime message binding, and rejection of provider-reported routing spoofing. `tests/store.rs` checks atomic identity/message binding, unknown custom identity, snapshots, fork rebinding, and reopen. `tests/recorded_time.rs` checks shared event/message times across promotion and assistant commit paths, stable replay/reopen/snapshot/export, preservation on fork, nullable legacy migration, and read-only export before migration.
