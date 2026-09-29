# Session Storage Hardening

## Goal

Bound the growth of the local SQLite database and remove the write amplification caused by
persisting full-state snapshots per streaming update, without changing session semantics or
data that replay consumers depend on.

## Measured problem (2026-09-29, local `miao.db`)

- File size 1.67 GB; the `event` table alone accounts for **1265 MB**.
- `event` has 126,625 rows, average 9.5 KB, single-row maximum **26.8 MB**.
- `message.part.updated.1`: **85,434 events for only 36,044 distinct parts** (each part is
  re-serialized and re-appended roughly 2.4 times as it streams).
- Inline base64 attachments: 155 MB inside `message.part.updated` payloads; 582 MB across all
  events. The largest single event is an embedded base64 PDF.
- V1 `message` (58 MB) and `part` (238 MB) store the same content as the event log.
- `session_message` (the V2 projection table) is empty — the running binary writes the legacy
  V1 sync events, not V2.
- `auto_vacuum = 0`; no retention, coalescing, or log compaction.

Reference: the tool-output store already externalizes large tool output to files
(`packages/core/src/tool-output-store.ts`), and workspace snapshots already use a
content-addressed git repository (`packages/core/src/snapshot.ts`). The session message log does
neither.

## Root cause

The cost is not SQLite versus files. It is the representation and lifecycle of persisted
records:

1. **Snapshot-per-delta**: streaming updates append the full, growing payload instead of a delta
   or the final state.
2. **Inline large payloads**: base64 attachments live inside event payloads and message parts.
3. **Double storage**: the same content exists in `event`, `part`, and `message`.
4. **No lifecycle**: no retention, compaction, or incremental vacuum.

Note: the **V2** event publisher already coalesces streamed deltas in memory and emits one event
per finished fragment (`packages/core/src/session/runner/publish-llm-event.ts`, `fragments()`),
and `to-llm-message.ts` already has a TODO to materialize remote and managed URIs. The 1.26 GB is
legacy V1 data plus the not-yet-migrated V1 write path, not a V2 design defect.

## Target architecture

- **Delta or final-state events only.** One durable record per completed fragment/message, never
  one per streamed token. (V2 already does this; the migration must not carry V1 forward.)
- **Content-addressed blob store for large payloads.** Attachments and oversized tool output
  live under `blobs/<sha256>`; messages and events store a `hash + mime` reference, not bytes.
  Reuse the existing `Hash.sha256` (`packages/core/src/util/hash.ts`) and the native blake3 helper.
- **Single source of truth.** The V2 `session_message` projection is the record; V1 `message` /
  `part` and their sync events are retired after migration.
- **Explicit lifecycle.** Incremental auto-vacuum, retention/compaction of the durable event log
  with snapshot-then-truncate, and reference-counted or mark-and-sweep blob GC scoped per project.
- **Portable export.** `miao export --jsonl <session>` reads the projection and writes one line
  per message for grep/diff/backup. Storage dedup is not token dedup: the model still receives
  materialized bytes.

## Migration plan (staged, non-destructive)

1. **Tooling first (this slice):** `miao db stats` reports file/table/event-type sizes;
   `miao db vacuum` reclaims free pages on demand; new databases enable
   `auto_vacuum = INCREMENTAL`. No automatic deletion of existing rows.
2. **Delta events:** land the V2 runner as the active path and stop writing V1 per-delta sync
   events. Do not copy V1 semantics into V2.
3. **Blob externalization:** add the blob store; migrate attachment payloads out of `event` and
   `session_message.data`; materialize references at request build time.
4. **Retire V1 tables:** after V2 is authoritative and a data migration backfills the projection,
   drop `message` / `part` and compact the legacy event range.
5. **Retention + GC:** snapshot-then-truncate the event log; mark-and-sweep blobs per project.

## Acceptance

- A representative database (same 47 sessions) drops from 1.67 GB to **under 200 MB**.
- Per provider turn, bytes written to `event` are proportional to the final text, not quadratic
  in the delta count.
- Zero base64 payloads in `event.data` or `session_message.data`; only hash references remain.
- `miao db stats` reports per-table and per-event-type sizes without depending on optional
  SQLite extensions.

## Non-goals

- Replacing SQLite with per-session JSONL files as the primary store. The load is relational and
  cross-session (list, search, stats, cost aggregation, server fan-out); SQLite is the right
  primary medium.
- Deduplicating identical bytes across sessions as the primary goal. Measured byte-level
  duplication is only ~1–3.4%; the win is stopping the re-write and externalizing, not dedup.
- Reducing API token cost. Dedup at rest does not reduce the bytes sent to the model.
