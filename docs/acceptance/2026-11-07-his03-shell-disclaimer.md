# Acceptance record — HIS-03 shell side-effect disclaimer

Item: `HIS-03`. Tree: `613907dd68` (branch `test/his03-shell-disclaimer`, parent
`origin/main` `94feff1256`). Commands ran on the Linux build host from
`crates/miao-tui` and `crates/miao-engine`. This record closes the half of
criterion 3 that `2026-11-05-his03-undo-and-snapshots.md` left open; criteria 1
and 2, and the outside-modification half of criterion 3, were accepted there.

## Criterion 3 (remaining half) — "never claim non-rollbackable shell or external side effects can be undone"

The 2026-11-05 record ended with: *"Not pinned: neither the preview payload
(`store::revert_preview`: `available`/`boundary_seq`/`snapshot_id`/`restore`/
`remove`/`conflicts`) nor any test states that shell commands and other
external side effects are outside what a revert undoes."* The sentence itself
has been in the TUI revert confirmation since #1663 (`2cae47596b`):
`RevertPlan::summary()` appends "Shell commands and other side effects cannot
be undone." to every plan it renders — history-only and file alike — and
`Dialog::confirm_revert` puts that summary verbatim in the undo dialog, which
the app opens when the preview arrives. What was missing was a test and a run.
Pinned here:

| what is pinned | test |
| --- | --- |
| a shell-only boundary (engine `available:false`, `no-file-snapshot`) names the side effects the revert leaves alone and claims no file work | `a_shell_only_boundary_names_the_side_effects_a_revert_leaves_alone` |
| a file plan keeps the disclaimer and never claims the workspace is untouched | `a_file_boundary_reports_files_and_still_disclaims_side_effects` |
| the undo confirmation itself carries the disclaimer | `the_revert_confirmation_names_the_side_effects_it_leaves_alone` |

**Command:** from `crates/miao-tui`, `cargo test --lib <name>` per row.
**Observed:** `test result: ok. 1 passed; 0 failed` for each of the three
(`565 filtered out` — the full suite is 566).

Full unit suite on the same tree: `cargo test --lib` → `566 passed; 0 failed`.

## Existing suites re-run on this tree

From `crates/miao-engine`, the suites the 2026-11-05 record cites — including
`preview_says_when_a_boundary_has_no_file_record` (the payload reports
`available:false` for a boundary with no file record instead of pretending to
restore files), and `preview_flags_a_path_that_changed_outside_the_session`
plus `restore_refuses_escapes_and_missing_data` (both inside `--test
snapshots`):

`cargo test --test snapshots` → `9 passed`; `cargo test --test revert` →
`2 passed`. Same counts as the 2026-11-05 record.

## What stays open

- The engine wire payload (`revert_preview`) carries no disclaimer field; the
  operator-facing disclaimer is the pinned TUI confirmation text. A client
  driving the engine API without the TUI sees no disclaimer sentence — but the
  payload also never claims undoability: it lists file paths only.
- Issue #1984's fourth box ("link the implementation PR with offline and live
  client acceptance records and target versions") still lacks a live-client
  run and a release stamp for HIS-03.

Result: the shell/external-side-effect disclaimer half of criterion 3 is
**accepted** on tree `613907dd68`.
