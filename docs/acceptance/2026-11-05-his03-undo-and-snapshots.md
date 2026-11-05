# Acceptance record — HIS-03 undo, redo and snapshot rollback

Item: `HIS-03`. Tree: `9b3aca3eb1`. Commands ran on the Linux build host from
`crates/miao-engine`. Every suite is Rust; the `packages/tui` dialogs named under the
item's "Evidence" are the implementation RUS-02 retires and carry nothing here.

## Criterion 1 — stage, clear and commit phases alongside undo and redo

| what is pinned | test |
| --- | --- |
| staging restores the files this Session touched, and clearing the stage undoes that | `stage_restores_touched_files_and_clear_undoes_it` |
| committing a stage soft-reverts and leaves no stage behind | `commit_soft_reverts_and_leaves_no_stage` |
| a commit reports the reverted count a redo can rely on | `commit_reports_the_reverted_count_a_redo_can_rely_on` |
| a redo of a reverted projection restores it | `revert_rewinds_the_projection_and_unrevert_restores_it` |

`cargo test --test snapshots` → `9 passed`; `cargo test --test revert` → `2 passed`.

## Criterion 2 — explicit boundaries for history-only, code-only or combined rollback

| boundary | test |
| --- | --- |
| a history-only stage rewinds a Session that never touched a file | `a_history_only_stage_rewinds_a_session_that_never_touched_a_file` |
| a boundary with no file record says so instead of pretending to restore files | `preview_says_when_a_boundary_has_no_file_record` |
| staging requires a captured boundary | `stage_requires_a_captured_boundary` |
| a revert past a compaction boundary drops that compaction | `revert_drops_compaction_at_or_after_the_boundary` |
| the file plan is reported without touching the workspace | `preview_reports_the_file_plan_without_touching_the_workspace` |

## Criterion 3 — preview outside modifications; never claim shell or external effects are undoable

Pinned half:

- `preview_flags_a_path_that_changed_outside_the_session` — a file whose disk content is
  not what the Session last recorded is reported as a conflict with its action, so an
  outside edit is visible *before* the revert;
- `restore_refuses_escapes_and_missing_data` — a manifest path that would escape the
  workspace, or whose data is gone, is refused rather than restored.

**Not pinned:** neither the preview payload (`store::revert_preview`:
`available`/`boundary_seq`/`snapshot_id`/`restore`/`remove`/`conflicts`) nor any test states
that shell commands and other external side effects are outside what a revert undoes. That
half of the criterion is unaccepted until a surface says it.

## Criterion 4 — linked PR, records and version

Satisfied by this record and its pull request; nothing here claims a live-client run.

Result: criteria 1 and 2 **accepted**; criterion 3 accepted for the outside-modification
preview and refusal paths, with the shell/external-side-effect disclaimer unaccepted.
