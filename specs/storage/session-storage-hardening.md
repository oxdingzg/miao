# Session Storage Hardening

## Status (2026-09-29)

Landed in the safe, standalone slice:

- `miao db stats` — reports file/table sizes and the per-event-type breakdown. Verified against the
  live database: `message.updated.1` 880 MB, `message.part.updated.1` 282 MB.
- `miao db vacuum` — checkpoints, requests `auto_vacuum = INCREMENTAL`, runs `VACUUM`, then
  `incremental_vacuum`. Confirmed the pragma flips 0 → 2 on a scratch database.
- `miao export --format jsonl <session>` — one JSON object per message for grep/diff/backup.

Landed since (2026-09-30), still standalone:

- `packages/core/src/blob.ts` — content-addressed blob store: `blobs/<sha256>` layout, `put` /
  `get` / `getBase64` / `has` / `remove`, atomic temp-then-rename writes, and dedupe on write, plus
  the `blob://<hash>` reference helpers (`refUri` / `isRef` / `hashOf`) used by the wiring plan
  below. Unit-tested in `packages/core/test/blob.test.ts`. Not yet wired into attachment or
  tool-output persistence.
- Request-time materialization: `packages/core/src/session/runner/materialize-files.ts` resolves
  `blob://<hash>` user attachments to inline data URIs (a missing/unreadable blob becomes a text
  note) so the model always receives bytes. Unit-tested in `session-runner-materialize.test.ts`.
  The write side and API-boundary materialization are still open.
- New databases request `PRAGMA auto_vacuum = INCREMENTAL` in the native SQLite layers before WAL
  writes the header (best-effort when another opener holds the lock). Existing databases keep
  `auto_vacuum = 0` until `miao db vacuum`. Covered by `database-migration.test.ts`.

Not in this slice (blocked on the V2 runner becoming the active write path; see Migration plan
stages 2–4):

- Retiring the V1 per-delta sync events (the 1.26 GB source). The V2 write path is already
  delta-only — one durable `text.started`/`text.ended` per fragment, no durable delta row
  (`packages/core/test/session-runner-recorded.test.ts`) — so this reduces to the Workstream B V1
  retirement and migration.
- Blob externalization for attachments, and materializing references in `to-llm-message.ts`.
- Log retention / compaction, blob GC.

Reason: the bloat lives in the legacy V1 write path (`message.updated.1` /
`message.part.updated.1`). The V2 publisher already coalesces deltas
(`session/runner/publish-llm-event.ts`), so the fix is to finish and activate V2 and migrate the
old rows — not to patch V1 in place.

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

## Blob wiring (implementation plan)

The `Blob` store (`packages/core/src/blob.ts`) exists; this is how to make it the storage medium for
attachments and oversized tool output.

1. **Reference encoding.** A stored payload is referenced as `uri: "blob://<sha256>"` in the fields
   that already carry a URI (`PromptInput.FileAttachment.uri` / `FileAttachment.uri`, and
   `Tool.Content` file `data`). `mime` and `name` stay inline. A helper `Blob.isRef(uri)` /
   `Blob.hashOf(uri)` centralizes parsing so no caller hand-splits the scheme.
2. **Write side.** Externalize at the two persistence boundaries, over a threshold (e.g. 256 KB
   decoded):
   - user prompt files at `SessionInput.admit` (store `prompt.files` with the ref),
   - tool-result file parts in `publish-llm-event` / `ToolOutputStore.bound`.
   Both already run inside `Effect`, so they can `yield* Blob.Service.put`.
3. **Read side / materialization.** Keep clients and the model on bytes:
   - the runner pre-processes projected history before `toLLMMessages`, resolving each `blob://`
     ref to a `data:<mime>;base64,…` URI (cache per turn; a missing blob becomes a text placeholder,
     never a broken media part);
   - the server materializes refs at the API boundary (`SessionV2.context`, `SessionV2.events`) so
     the TUI/app keep receiving data URIs and need no change. This is the seam that avoids touching
     every client.
4. **Migration.** A one-time, idempotent `miao db externalize-blobs` (like `db backfill`) rewrites
   existing inline base64 in `session_message.data` and `event.data` into refs, per session, in one
   transaction, with `--dry-run` reporting counts.
5. **GC.** Mark-and-sweep per project: collect `blob://` hashes referenced by the project's
   `session_message`/`event` rows, delete unreferenced blobs older than the retention window.
   Runs from the existing `tool-output-cleanup` global loop.
6. **Acceptance.** `miao db stats` shows zero inline base64 in `event.data`/`session_message.data`,
   only refs; a large attachment round-trips to the model and renders in the TUI; `db vacuum`
   reclaims the freed pages.

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

### Status (2026-10-04)

Steps 1–4 are implemented; 5 is open.

- Step 2 + 4: `miao db backfill` projects the V1 history through the fidelity mapping in
  `session/v1-read.ts` (`db backfill --verify` maps and encodes every row without writing), and
  `miao db compact` deletes the legacy `message.*` event range in batches, drops `message` /
  `part`, resets only the `event_sequence` rows it emptied, then vacuum. Measured locally:
  `miao-local.db` 816 MB → 48.8 MB; `miao.db` 2500.6 MB → 334.7 MB; `miao-main.db` 2153 MB →
  176.7 MB, with sampled transcripts byte-identical to their pre-compact baselines.
- Step 3: prompt attachments are externalized on write
  (`SessionBlobStorage.externalizePromptAttachments`), tool-result files are externalized at the
  single tool-result settle boundary (`SessionBlobStorage.externalizeToolContent`), and reads
  materialize `blob://` refs back to data URIs (`materializeBlobRefs` / `materializeToolContent`).
  `miao db externalize-blobs` rewrites the inline payloads already stored in
  `session_message.data` / `event.data`, and `miao db stats` reports the blob store and any
  remaining inline base64.
- The `<200 MB` acceptance is not met for `miao.db` yet: 297 MB of the remainder is
  `session_message`, which is now the single copy of the history (V1 held it twice, in `part` and
  `message`). Reaching the target needs step 5 plus running the step-3 migration over the existing
  rows.

**Ordering precondition.** Compacting a database is only safe once every build that opens it
carries the "legacy tables are retired" fallback (`SessionLegacyTables.present`). A build from
before that fallback reads a compacted database as `SQLiteError: no such table: message` from
`SessionStore.context` / `SessionStore.historyState` — it does not degrade, it fails every read.
`miao db compact` runs from the checkout, while the database it rewrites is usually opened by the
installed release binary, so the release has to ship first. On 2026-09-30 the two release-channel
databases were compacted while the installed CLI (0.0.21) predated the guard and both had to be
restored from backup.

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
