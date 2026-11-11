# Acceptance record — HIS-03 the revert never claims a shell side effect back

Item: `HIS-03` (#1984). Tree: the pull-request head for branch
`test/his03-shell-disclaimer`, parent `origin/main` `3fdf81b016`. Commands ran on the
Linux build host in a synced copy of this tree, from `crates/miao-tui`,
`cargo 1.99.1`, debug profile. A reviewer runs the same commands from the same directory
anywhere.

`2026-11-05-his03-undo-and-snapshots.md` accepted the stage/clear/commit phases, undo and
redo, and the history-only versus file-rollback boundaries, and named one half of
criterion 3 as **unaccepted**: the preview carried no statement that a shell command or
any other external side effect is outside what a revert undoes. That half landed as
`test(tui): pin the shell side-effect disclaimer (HIS-03)` (`#2740`, `930e19730a`, first
released in `v0.3.54`); this record is the re-verification on the current tree, and it
closes the item.

## Criterion — "Preview external modification conflicts before reverting and never claim non-rollbackable shell or external side effects can be undone."

| surface | command | observed |
| --- | --- | --- |
| a revert that would only undo shell work says what it cannot undo | `cargo test --lib a_shell_only_boundary_names_the_side_effects_a_revert_leaves_alone` (`crates/miao-tui`) | `test session::tests::a_shell_only_boundary_names_the_side_effects_a_revert_leaves_alone ... ok` |
| a revert that does undo files still names the side effects it leaves behind | `cargo test --lib a_file_boundary_reports_files_and_still_disclaims_side_effects` (`crates/miao-tui`) | `test session::tests::a_file_boundary_reports_files_and_still_disclaims_side_effects ... ok` |
| the confirmation dialog carries the same sentence before the operator commits | `cargo test --lib the_revert_confirmation_names_the_side_effects_it_leaves_alone` (`crates/miao-tui`) | `test dialogs::tests::the_revert_confirmation_names_the_side_effects_it_leaves_alone ... ok` |
| all three in one run | `cargo test --lib side_effect` (`crates/miao-tui`) | `test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 622 filtered out; finished in 0.00s` |

The sentence the operator sees is `Shell commands and other side effects cannot be
undone.` It is attached in `crates/miao-tui/src/session.rs` to both boundary kinds —
a boundary with no file changes, and a boundary whose files do change — and it is
repeated in the revert confirmation in `crates/miao-tui/src/dialogs.rs`, so the claim is
made before the decision rather than after it.

## Criterion — "Link the implementation PR with offline and live client acceptance records and target versions."

- Implementation PRs: `#2546` (undo, redo, snapshot boundaries), `#2740` (the disclaimer),
  and this record's pull request.
- Offline records: `2026-11-05-his03-undo-and-snapshots.md` and this one.
- Version: `v0.3.60`, the latest published release whose tree contains `930e19730a`.

## What this record does not claim

- No real terminal session was driven for the dialog wording: the rows above render the
  widget and assert its text, which is what the criterion is about, and a live visual pass
  belongs to UX-04's terminal matrix.
- Nothing here re-measures cost or latency: HIS-03 changes no hot path, so there is
  nothing to compare.

roadmap: HIS-03 done in v0.3.60
