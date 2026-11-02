# DATA-03 — maintenance actions mapped to the tree

DATA-03’s first acceptance item is a map: *stats/backfill/vacuum/compact/restore/
externalize/gc/retention are mapped item by item*. This record is that map at
`main` after #2265, with the check that produced each row.

Commands were run from the repository root; `cli:` counts occurrences in
`crates/miao-cli/src/cli.rs`, `engine:` counts `fn <name>` in
`crates/miao-engine/src/*.rs`.

```
for c in backfill compact restore externalize gc retention; do
  printf "%-12s cli:%s engine:%s\n" "$c" \
    "$(grep -c "\"$c\"" crates/miao-cli/src/cli.rs)" \
    "$(grep -rc "fn $c" crates/miao-engine/src/*.rs | awk -F: '{s+=$2} END {print s+0}')"
done
```

## The map

| action | CLI | engine | what it does today | authorisation |
| --- | --- | --- | --- | --- |
| `path` | `miao db path` | — | prints the database this workspace uses | none needed, reads nothing |
| `stats` | `miao db stats` (#2265) | — | file size, page count × page size, free pages, row count per table; opens `SQLITE_OPEN_READ_ONLY` | none needed, cannot write |
| `vacuum` | `miao db vacuum [--apply]` (#2265) | — | the same report, then reclaims free pages **only** with `--apply` | dry run by default; `--apply` is the authorisation |
| `compact` | — | 2 fns, `history.rs` | **not storage compaction.** `Store::compact` and `compact_for_run` write a *context checkpoint* from a host-supplied `summary` and `through` sequence — Session authority, not page reclamation. Exposing them as `miao db compact` would let the CLI re-create that authority, which DATA-03 forbids. Reclaiming free pages is `vacuum`. | not applicable |
| `restore` | — | 4 unrelated fns | **no database restore exists.** The hits are `patch.rs` (restoring patch text), `snapshot.rs` (`restore_manifest`), `permission_legacy.rs` (a test fixture) and `history.rs` (`restore_note`, a restart message). File-level backup and restore belong to DATA-05, not here. | not applicable |
| `backfill` | — | — | absent in both | — |
| `externalize` | — | — | absent in both (blob store is a later spec step) | — |
| `gc` | — | — | absent in both | — |
| `retention` | — | — | absent in both | — |

Adjacent commands that are **not** database-file maintenance, listed so they are
not mistaken for it: `miao stats` (Session usage), `miao doctor` (readiness),
`miao memory` (context window), `miao export` (Session export).

## Where the storage spec and the Rust tree disagree

`specs/storage/session-storage-hardening.md` is the basis DATA-03 cites. Three of
its statements do not hold for the Rust engine:

1. **Its tables are not the Rust tables.** The spec’s retention plan is written
   against `event` and `session_message`. `grep -rn session_message --include=*.rs
   crates` returns nothing, and no Rust module creates an `event` table, so
   “events before each Session’s compaction baseline” has no direct meaning in
   the Rust schema. `miao db retention` cannot be implemented from the spec text
   alone; what is prunable in the Rust schema is a design question, and it is the
   reason that action is still absent rather than merely unwired.
2. **“`miao db retention` reports prunable rows — **Done** — report-only”** is a
   statement about the TypeScript host. There is no such command in this tree.
3. **`auto_vacuum = INCREMENTAL` for new databases** (migration plan, step 1) was
   not set anywhere. **Since fixed:** a database created from scratch now sets
   the pragma before its first table, so free pages are handed back as the file
   shrinks; a database that already exists keeps its own setting, because
   changing it needs a full VACUUM and that is the operator's call. Covered by
   `crates/miao-engine/tests/auto_vacuum.rs`.

## What each remaining slice needs

| action | next step | blocked on |
| --- | --- | --- |
| `compact`, `restore` | **no slice is wanted.** `compact` would re-create Session authority in the CLI; `restore` has no database-side implementation to wire. Both rows are corrected above rather than carried as pending work. | — |
| `retention` | define “prunable” against the Rust schema, then the report-only form the spec asks for | design |
| `backfill`, `externalize`, `gc` | the blob store and the projection move are prerequisites named by the spec | design, and the spec steps that precede them |
| `auto_vacuum` | **done**: set before the first table of a new database; an existing database keeps its setting | — |

## Correction after review

The first version of this map said `compact` and `restore` each had four engine
functions and were only "not reachable from the CLI". That was wrong in a way
that mattered: it read as unwired plumbing, so the obvious next step would have
been to wire it. Reading the signatures shows both names are used for something
else in this tree — a context checkpoint and four unrelated helpers — and the two
tables above now say so.

## Accepted here

- `stats` and `vacuum` are mapped, name their target by default, and treat real
  data as something altered only under `--apply` (#2265).
- Every remaining action is listed with the check that found it absent, so
  neither a missing command nor a stale spec claim can be read as complete work.
