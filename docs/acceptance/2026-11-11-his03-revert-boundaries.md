# Acceptance record — HIS-03 the three revert boundaries and the outside-edit gate

Item: `HIS-03` (#1984). Tree: the pull-request head `a2d7633b5b` for branch
`feat/issue1984` (PR #2866), parent `origin/main` `69d637a4aa`. Every command below ran
on GitHub Actions on that tree, not on a workstation: the `engine` and `tui` jobs of
`ci.yml`, at the crate directories those workflows use. CI run `42954116083` is the run
this record reads and it concluded `success`; a reviewer reproduces a row by pushing the
tree and reading the same job.

Earlier records for this item — `2026-11-05-his03-undo-and-snapshots.md` and
`2026-11-11-his03-shell-side-effects.md` — accepted the stage/clear/commit phases,
undo and redo, the history-only boundary, and the shell-side-effect disclaimer.
What they could not accept is the rest of criterion 2 and the enforcement half of
criterion 3, because neither existed:

- `revert_stage` took `files: bool`, so a caller could rewind the conversation
  (`false`) or move files and history together (`true`). "Put the workspace back at
  this boundary and leave the transcript alone" was inexpressible, so the
  criterion's three boundaries were really two.
- `revert_preview` listed paths that changed outside the Session, but
  `revert_stage` overwrote them anyway. The preview was advice the engine never
  checked.

This tree adds the third boundary, makes the boundary durable as a `scope`, and
turns the preview into a gate.

## Criterion — "Retain stage, clear, and commit phases alongside undo and redo operations."

Not re-measured here; `2026-11-05-his03-undo-and-snapshots.md` is the record for
this criterion, and this tree does not change those phases. What it does change is
what a commit may move, which is the criterion below.

## Criterion — "Clearly define operational boundaries for history-only, code-only, or combined rollbacks."

| boundary | command | observed |
| --- | --- | --- |
| a code-only stage restores the files and leaves every message row alone: `scope: "files"` in the reply, in the durable stage, and in `revert.staged`/`revert.committed`, with `reverted: 0` and `message_count` unchanged | `cargo test --test snapshots a_code_only_stage_restores_files_and_leaves_the_transcript_alone` (`crates/miao-engine`) | `test a_code_only_stage_restores_files_and_leaves_the_transcript_alone ... ok`; the whole target printed `test result: ok. 12 passed; 0 failed; 0 ignored` in job `130305478654` |
| a stage that moves neither files nor history is refused instead of recording an intent that can never change anything | `cargo test --test snapshots a_revert_that_moves_nothing_is_refused` (`crates/miao-engine`) | `test a_revert_that_moves_nothing_is_refused ... ok` (same target and job) |
| the durable stage names its scope, so a client that reconnects reads the boundary instead of inferring it | `cargo test --test snapshots a_history_only_stage_rewinds_a_session_that_never_touched_a_file` (`crates/miao-engine`) | `test a_history_only_stage_rewinds_a_session_that_never_touched_a_file ... ok` — it asserts `committed["scope"] == "history"` (same target and job) |
| the code-only confirmation says the transcript stays, and the combined one says it leaves | `cargo test --lib a_code_only_revert_says_the_transcript_stays` (`crates/miao-tui`) | `test session::tests::a_code_only_revert_says_the_transcript_stays ... ok`; job `130294853361`, whole lib run `test result: ok. 636 passed; 0 failed; 0 ignored` |
| the product reaches the code-only boundary: `undo-files` previews the same turn as `undo` and sends `files: true, history: false` | `cargo test --lib undo_files_previews_the_same_turn_as_a_code_only_revert` (`crates/miao-tui`) | `test app::tests::undo_files_previews_the_same_turn_as_a_code_only_revert ... ok` (same job) |
| a code-only undo at a boundary with no file record says so instead of opening a prompt that would move nothing | `cargo test --lib a_code_only_undo_at_a_boundary_without_files_says_so_instead_of_asking` (`crates/miao-tui`) | `test app::tests::a_code_only_undo_at_a_boundary_without_files_says_so_instead_of_asking ... ok` (same job) |

## Criterion — "Preview external modification conflicts before reverting and never claim non-rollbackable shell or external side effects can be undone."

| part | command | observed |
| --- | --- | --- |
| the preview and the stage compute one plan, and the stage refuses to overwrite a path that changed outside the Session, naming the paths, until the caller passes `force` | `cargo test --test snapshots a_stage_refuses_an_outside_edit_until_the_caller_forces_it` (`crates/miao-engine`) | `test a_stage_refuses_an_outside_edit_until_the_caller_forces_it ... ok` — an unforced stage fails naming `a.txt`, leaves the outside edit and no staged intent, and the forced stage reports `conflicts_overwritten` |
| the preview payload itself says external effects are outside every boundary (`external_side_effects: "not_reversible"`), so a client does not have to own the sentence | `cargo test --test snapshots preview_reports_the_file_plan_without_touching_the_workspace` (`crates/miao-engine`) | `test preview_reports_the_file_plan_without_touching_the_workspace ... ok` — it asserts `preview["external_side_effects"] == "not_reversible"` |
| the confirmation that showed the conflicts is what releases the gate: a confirmed revert reads `force` from the plan's conflicts, and a plan without conflicts does not | `cargo test --lib a_revert_confirm_names_the_outside_edits_it_overwrites` (`crates/miao-tui`) | `test app::tests::a_revert_confirm_names_the_outside_edits_it_overwrites ... ok`; it asserts `files: true, history: true, force: true`; `a_revert_without_a_file_record_leaves_the_workspace_alone` asserts `force: false` |
| no boundary claims a shell command back | `cargo test --lib side_effect` and `cargo test --lib a_file_boundary_reports_files_and_still_disclaims_side_effects` (`crates/miao-tui`) | `... ok` in the 636-test lib run of job `130305478542` — the disclaimer is unchanged by this tree and re-pinned rather than re-invented |

## Criterion — "Link the implementation PR with offline and live client acceptance records and target versions, including quality, cost, or duration evidence if optimized."

- Implementation: PR #2866, branch `feat/issue1984`.
- Offline records: this one, plus the two earlier HIS-03 records above.
- CI: run `42954116083` concluded `success`; engine job `130305478654` and TUI job
  `130305478542` green, plus `engine (windows compile)` green. No release ships this
  tree yet, so no target version is claimed and no release stamp is written here.
- Live client: not exercised. The TUI rows render the confirm dialog and assert its
  text and the request it sends, which is what these criteria are about; a visual
  pass belongs to UX-04's terminal matrix.
- No optimisation is claimed, so there is no quality/cost/duration evidence to
  attach.

## What is not accepted yet

Nothing in this record's scope. One earlier run of this branch, `42950926493`, failed
because `crates/miao-engine/tests/delegation_benefit.rs` did not compile — an
`Event` formatted with `{stop}` — a defect that predated this branch on
`origin/main`. It was fixed by its own pull request, `#2865`, which merged as
`69d637a4aa`; this tree is rebased onto that commit, which is why the engine suites
run here. The commit is named because it is what makes these rows evidence.

## What this record does not claim

- Nothing about Windows: the boundary logic is platform-independent, but the
  Windows legs of both suites are unexercised on this tree.
- Nothing about a live terminal session, and nothing about `redo` semantics beyond
  what `2026-11-05-his03-undo-and-snapshots.md` already pinned: `unrevert` still
  restores messages only and never re-applies files.
- Nothing about optimised throughput: HIS-03 adds no hot path.
