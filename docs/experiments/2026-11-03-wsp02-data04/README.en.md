# 2026-11-03 WSP-02 whole-path vcs measurement + DATA-04 blob externalisation

Two roadmap legs, one branch (`feat/wsp02-vcs-whole-path`), each answering a
different acceptance question. The measurement leg times the whole path a
large `vcs_status`/`vcs_diff` answer takes — git, parse, wire, decode,
paint — because a single faster git primitive does not prove the operator's
wait got shorter. The DATA-04 leg moves oversized event payloads to
content-addressed files and adds an explicit GC pass with a repeatable disk
curve.

## Leg 1 — WSP-02 item 3: whole-path numbers

Harnesses: `crates/miao-engine/tests/vcs_scale.rs` (engine layer on a
synthetic 5000-file tree carrying a 3350-entry mixed change set: 3000
modified, 100 staged-then-edited, 20 pure `git mv` renames, 30 deleted,
200 untracked inside a tracked directory) and
`crates/miao-tui/tests/vcs_latency.rs` (a real TUI over a real wire against
the scripted engine, scaled to a 3300-entry answer; leader chord to painted
file count, plus paint-only and decode-only baselines).

Engine layer, release, the macOS build host (M4, macOS):

| scenario      | engine p50/p95 ms | bare git p50/p95 ms | engine share p50 ms | answer bytes |
| ------------- | ----------------- | ------------------- | ------------------- | ------------ |
| status, 3350 entries | 55 / 63    | 50 / 53             | ~5                  | 317,653      |
| status, 50 entries   | 39 / 53    | —                   | —                   | 4,821        |
| diff, one file       | 28 / 33    | 24 / 30             | ~4                  | 226          |

A patch three times the answer cap is refused immediately with the
truncation fact (`an_oversized_diff_refuses_instead_of_stalling`) instead of
streaming the whole patch.

Reading: the git primitive dominates the whole path; the engine's own share
(parse plus JSON building) stays single-digit milliseconds at 3350 entries,
and the answer rides one 310 KiB wire frame.

TUI layer numbers and the disk curve live in `raw/`.

## Leg 2 — DATA-04 items 1 + 3: blob externalisation and GC

Design, in `crates/miao-engine/src/blob.rs`: a string value past 64 KiB
moves to `<ledger dir>/blobs/<sha256[..2]>/<sha256>` and the row carries
`{"blob": ..., "bytes": ...}` in its place. Identical documents share one
file, which is the point: the real 1.2 GB ledger copies the same permission
ruleset onto 26k provider requests and pastes attachments twice (admitted
and promoted).

- Write path: externalisation happens inside the append, with the blob root
  derived from the connection's own ledger path — none of the 75 append
  call sites changed. The returned Event rehydrates, so broadcasts and
  in-process readers always see the original text.
- Read path: the three assembly points that hand an event to a consumer
  (`events`, `latest_event`, export) rehydrate. SQL consumers that reach
  into `data` with `json_extract` (cron, usage, permission projections)
  only touch small fields, which stay inline by construction. Session
  transfer goes through export, which rehydrates, so a moved session is
  self-contained.
- A missing blob file rehydrates as the reference itself: the reader sees
  the fact instead of a failure, and gc's report names the hole.
- GC: `miao db blob-gc` scans the ledger's references through one read-only
  snapshot, then removes what nothing references — vacuum's dry-run /
  `--apply` contract. Staging writes a crash left behind are collected in
  the same walk.

Real-ledger rehearsal (read-only copy of the 1.24 GB production ledger):

- event rows past 64 KiB hold ~116 MB, of which 91% is covered by the
  string-value threshold (attachment base64 payloads).
- `blob-gc` dry run over the real ledger: 0 live references, 0 orphans —
  a no-op, which is correct before any externalisation has run.

Test evidence lives with the branch: unit tests for roundtrip, dedup,
missing-file defence, GC keeping live references, and the dry run deleting
nothing; integration tests for the row shrinking to a sub-200-byte
reference and reading back whole, for truncation + gc removing exactly the
orphan, and for the 10-turn disk curve (ten copies of a repeated 128 KB
ruleset collapse to one file; the ledger stays under half the inline size).
