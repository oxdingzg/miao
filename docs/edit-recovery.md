# Stale-edit recovery (snapshot rebase)

Models edit the file they last read. When the file has drifted since that read
— a linter rewrote it, a parallel tool touched it, the model itself edited a
neighbouring block — `oldString` no longer occurs in the current text, the
exact/fuzzy matcher reports "could not find oldString", and the model pays a
full re-read turn to retry an edit whose intent is perfectly clear.

This spec adds one recovery step to the edit failure path. It is invisible to
the model: no read-output format change, no new edit syntax, no prompt change.

## Mechanism

1. `EditSnapshots.Service` (Location-scoped, LRU: 24 files, 512 KiB each)
   records the text the model actually saw after every successful text `read`
   (`read.ts` registers in the same success funnel as the LSP warm).
2. In `plan()`, only when `EditMatch.match` returns `none`, the snapshot is
   consulted via the pure `EditRecovery.recover({ snapshot, current, oldString })`:
   - `oldString` must occur in the snapshot exactly once, else the failure is
     returned unchanged (`inapplicable` / `ambiguous`).
   - Up to 3 context lines are collected walking outward from the snapshot
     block on each side; an anchor is a non-empty line that occurs **exactly
     once** in the current file. At least one anchor (or a file boundary) is
     required, else `refused: unanchored`.
   - The current-file region strictly between the two anchors (or between the
     one anchor and the file boundary) is replaced by `newString`. The region
     may exceed the snapshot block by at most 8 lines, else
     `refused: disproportionate`.
   - Recovery returns the replaced text plus a note string; `plan` surfaces it
     as `replacements: 1` with the optional `note` on the tool output.
3. `replace_all`, `ambiguous`, and `disproportionate` never rebase.

## Correctness invariants

- I1: recovery runs only on the existing failure path; every edit that
  succeeds today behaves bit-for-bit identically.
- I2: the target region is located by exact, unique context anchors — position
  is proven, never guessed.
- I3: the replaced region is bounded, so a wholesale clobber of a heavily
  drifted file is refused rather than applied.
- I4: the permission diff and the returned patch show the real before/after,
  including any drift the rebase discarded, and the output carries an explicit
  note that the edit was rebased.
- I5: `writeIfUnchanged` still guards the final write; interruption and
  concurrency semantics are untouched.
- I6: no schema, prompt, or model-visible format changes.

## Verification gates

- Unit tests pin the pure recovery semantics (golden cases for drift on
  either/both sides, file boundaries, refusals) and the integration (red on
  base: a drifted-file edit fails today, recovers with the change).
- `script/edit-recovery-bench.ts` sweeps generated stale-edit scenarios over
  real repository files: recovery rate on cases that fail today, and zero
  out-of-region applications (ground-truth byte equality outside the replaced
  region).
