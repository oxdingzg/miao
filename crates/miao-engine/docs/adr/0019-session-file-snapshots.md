# 0019. Session-owned file snapshots and three-phase revert

Status: accepted (implemented; schema 26)

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

- `Command::RevertStage { session_id, boundary_seq, files, history, force }`
  restores the workspace to the snapshot at (or before) that boundary, as far as
  `files` asks, and records a **staged revert** —
  `revert.staged {boundary_seq, snapshot_id, scope, restored: [...],
  created: [...], removed: [...]}` — as durable state. It touches no
  conversation row.
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

### The three boundaries

`RevertStage` takes `files: bool` (default `true`) and `history: bool` (default
`true`), and the pair names the boundary the caller asked for:

| `files` | `history` | boundary | files | conversation |
| --- | --- | --- | --- | --- |
| `true` | `true` | combined (`scope: "both"`) | restored to the boundary | rewound by `commit` |
| `true` | `false` | code only (`scope: "files"`) | restored to the boundary | untouched |
| `false` | `true` | history only (`scope: "history"`) | untouched | rewound by `commit` |
| `false` | `false` | none | — | — |

The last row is refused rather than recorded: a stage that may move nothing is
an intent that can never change anything. A Session that never wrote a file has
no snapshot at any boundary, and refusing its revert would make a pure
conversation read-only, which is the third row: the stage records an empty file
set and `commit` still rewinds history.

The boundary is durable, not inferred. The stage row stores it in
`engine_staged_revert.scope` (schema 26, additive: a row written before the
column existed was always combined, and the default says so), `commit` reads it
from there, and every reply and `revert.*` event names it as `scope`, so no
client has to reconstruct the boundary from two booleans after a restart.

### Preview

`Command::RevertPreview { session_id, boundary_seq }` answers what a stage would
change without changing anything: `{available, boundary_seq, snapshot_id,
restore, remove, conflicts}`, or `{available: false, reason}` where `reason` is
`no-location` or `no-file-snapshot`. A path is a **conflict** when its current
on-disk content differs from the newest content the Session itself recorded for
it — that is an edit the Session did not make, which a restore would overwrite,
so a client must show it before confirming. A path whose disk content equals the
Session's own last record is this Session's own work, which is the thing a revert
exists to undo, and is not reported as a conflict. The preview refuses while a
run is active, exactly like a stage.

The preview is also the gate. `RevertStage` computes the same plan through the
same function and **refuses while a conflict exists** unless the caller passes
`force: true`, naming the paths it would have overwritten. A caller sets `force`
only after it has shown those paths to the operator, which is what keeps the
preview and the stage from drifting into advice the engine never checks. The
reply reports what was overwritten as `conflicts_overwritten`. A path whose
write has not reached a settled boundary yet is not in the Session's record, so
it reads as an outside edit; capture and the gate therefore share one ordering,
and a client that stages without a preview still cannot lose an operator edit.
A path with no record at all has no baseline to be an outside edit against, so
it is not a conflict. Native manifests only contain touched-and-captured paths,
which makes that case an imported manifest: a transfer brings files this engine
never captured, and refusing every one of them would make an import
unrestorable.

The preview also states `external_side_effects: "not_reversible"`, so the
payload itself — not just a client's own copy — says that shell commands and
other external effects are outside every boundary.

`snapshot` replies carry `reverted_count`, the number of soft-reverted rows a
`unrevert` would restore. It is the durable signal a redo affordance reads:
nothing else in the snapshot distinguishes "revert never happened" from
"revert happened and hid nothing".

### What undo can and cannot reverse

The phases are deliberately asymmetric, and the client must state that rather
than imply a full undo:

| Action | Files | Conversation | Reversible by |
| --- | --- | --- | --- |
| `stage` | restored to the boundary | unchanged | `clear` |
| `clear` | reversed to the pre-stage state | unchanged | — |
| `commit` (combined) | unchanged since stage | rewound (soft) | `unrevert` |
| `commit` (code only) | unchanged since stage | **untouched** | — |
| `commit` (history only) | untouched | rewound (soft) | `unrevert` |
| `unrevert` | **not** re-applied | restored | — |

So a TUI "undo" is stage-then-commit: it both moves files and rewinds history,
and its redo (`unrevert`) brings the messages back but leaves the workspace as
the revert left it. The code-only boundary is `undo-files`: the same stage with
`history: false`, its commit touches no message row, and its `reverted` count is
0, so there is nothing for a redo to bring back. Shell commands, network calls, and any other external side
effect a turn performed are outside every one of these phases and are never
reversed; a confirm dialog says so.

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
6. **An outside edit is never overwritten silently.** A stage that would
   overwrite a path the engine did not record as this Session's own work fails
   until the caller passes `force`, and the refusal names the paths.

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
3. Protocol: the three commands plus their event shapes, `revert_preview`, the
   `files`/`history` stage flags with their `scope` vocabulary, the `force` gate,
   `reverted_count` in `snapshot` replies, and the snapshot record in `snapshot`
   replies as available/unavailable with its boundary.
4. Facade: `session.revert.stage/clear/commit` serve native placements; the
   product projection maps the new events onto its revert state.
5. Tests: engine (capture/restore round trip, staged-clear symmetry, commit
   soft-reverts and stays unrevertable, retention keeps referenced blobs, path
   escape refused, missing blob refuses a commit) plus an HTTP acceptance test.
