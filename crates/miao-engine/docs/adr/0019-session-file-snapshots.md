# 0019. Session-owned file snapshots and three-phase revert

Status: accepted (implemented; schema 16)

## Context

The product's revert is three-phase: `stage` restores the workspace to a chosen
message boundary and remembers the intent durably, `clear` undoes that restore,
and `commit` makes it permanent by rewinding the conversation. Native Sessions
refuse all three because the engine's `revert`/`unrevert` only rewind *the
conversation* (a soft `reverted=1` mark that `unrevert` can lift) and the engine
has no file snapshot at all: nothing in the engine records what the workspace
looked like at a boundary.

The product's own snapshot service is host-side (a git-based tree capture). If a
native Session keeps relying on it, the engine's durable record of a turn and
the files that turn produced live in two places with two lifetimes, and a
`commit` cannot be reasoned about after a crash. This decision gives the engine
its own snapshot so the three phases are one durable story.

## Decision

### Capture

At each **settled assistant boundary** — the same boundary compaction and agent
changes use — the engine captures the workspace file set it is responsible for:
every path the Session's runs wrote or deleted since the previous snapshot,
plus, for a git workspace, the tracked tree (so an operator edit inside a
snapshot boundary is not silently attributed to the Session). Capture is
content-addressed and deduplicated inside the Session's storage:

```
engine_file_snapshot(id, session_id, boundary_seq, kind, manifest, created_seq)
```

`kind` is `git` (a tree written through a temporary index, recorded as the
commit/tree id) or `paths` (a bounded manifest of `path → blob id` for the
Session's touched paths). Blobs live under the Session's storage directory and
are pruned by retention: the newest snapshot per Session, plus any snapshot a
staged revert or an unreverted marker references, plus the last N boundaries
(default 20), bounded by total bytes (default 256 MiB per Session). Pruning never
removes a referenced blob; the record of every snapshot is kept permanently, so a
pruned snapshot reports `available: false` instead of lying.

### The three phases

- `Command::RevertStage { session_id, boundary_seq }` restores the workspace to
  the snapshot at (or before) that boundary and records a **staged revert** —
  `revert.staged {boundary_seq, snapshot_id, restored: [...], created: [...],
  removed: [...]}` — as durable state. It touches no conversation row.
- `Command::RevertClear { session_id }` reverses the staged restore exactly (the
  same file set, in the opposite direction) and records `revert.cleared`. It
  refuses when there is no staged revert, and is idempotent per stage.
- `Command::RevertCommit { session_id }` makes it permanent: it rewinds the
  conversation through the existing soft revert (rows are marked, not deleted —
  the ledger keeps the audit trail and `unrevert` stays available), then records
  `revert.committed {boundary_seq, snapshot_id, from_seq, reverted}`.

A Session may hold at most one staged revert; staging a second one clears the
first's file effects before applying the new one, so a crash between the two
leaves at most one intent to reconcile. On startup the engine reports staged
reverts through the existing recovery surface rather than silently completing or
discarding them.

### Invariants

1. **Files are restored from the Session's own record, not from the host.**
   `commit` is meaningful after a crash and after the host process is gone.
2. **Nothing is destroyed before commit.** `stage` and `clear` move files;
   `commit` is the only phase that changes history, and it does so softly.
3. **A restore is bounded and reported.** Every phase returns the exact file
   sets it touched, and a restore that cannot complete (missing blob, refused
   path outside the workspace) fails the phase without a partial `commit`.
4. **Workspace escape is impossible.** Capture and restore both refuse symlinks
   that leave the workspace and any path the Session's Location does not own,
   reusing the path policy the edit tools already enforce.
5. **Retention is deterministic.** The pruning rule is a function of the stored
   records, not of wall-clock timing, so the same history prunes identically.

## Rejected alternatives

- **Host-side snapshots with engine-side conversation revert.** Two owners, two
  lifetimes; a `commit` could rewind history whose file restore never happened
  (or vice versa) with no way to tell afterwards.
- **Hard-deleting reverted messages on commit (the TS behaviour).** The engine's
  ledger is append-only evidence; soft revert plus `unrevert` gives the same
  transcript with an audit trail, and the existing revert/unrevert semantics stay
  single-sourced.
- **Snapshotting every tool write.** Many writes per turn, mostly intermediate;
  the settled-boundary capture keeps one snapshot per turn and matches the
  boundary the product's revert UI actually offers.
- **Storing snapshots as full copies.** Content addressing plus dedup is what
  keeps a 20-boundary retention inside the storage budget.

## Implementation plan

1. Store: `engine_file_snapshot` table, blob store under the Session's storage,
   capture at the settled boundary, retention and pruning, staged-revert records.
2. Runtime: capture hook next to compaction/agent application; `stage`/`clear`/
   `commit` with the file-set report; recovery reporting for a staged revert.
3. Protocol: the three commands plus their event shapes; the snapshot record in
   `snapshot` replies as available/unavailable with its boundary.
4. Facade: `session.revert.stage/clear/commit` serve native placements; the
   product projection maps the new events onto its revert state.
5. Tests: engine (capture/restore round trip, staged-clear symmetry, commit
   soft-reverts and stays unrevertable, retention keeps referenced blobs, path
   escape refused, missing blob refuses a commit) plus an HTTP acceptance test.
