# Acceptance record — migration, cross-process start and transfer

Tree: `04dc191a01`, plus the two changes this record travels with: `miao db backup`
(#2485) and the reopen test in `crates/miao-engine/tests/migration.rs`. Every command
below ran from `crates/miao-engine/` (except the `miao db backup` line, which ran from
`crates/miao-cli/`) on the macOS build host with `cargo 1.99.1`, debug profile:

```sh
cargo test --locked --no-fail-fast --test migration --test catalog --test export \
  --test concurrent_open --test doctor --test transfer --test transfer_stage \
  --test transfer_activation --test transfer_history --test transfer_move \
  --test workspace_transfer --test fork_identity
# 40 passed, 1 ignored, 0 failed across the twelve binaries
# (migration ran 4 without the reopen test and 5 with it)

cargo test --locked --bin miao -- backup   # from crates/miao-cli/, 1 passed
```

## DATA-01 — migration, cross-process start and downgrade refusal

| criterion | command | observed |
| --- | --- | --- |
| migrating the old product database and the engine database is repeatable and resumable after an interruption | `cargo test --test migration --test transfer` | engine side: `migration_stage_cutover_complete_freezes_and_reopens_the_session`, `migration_abort_is_pre_cutover_only_and_exported_sources_remain_fenced`, `migration_refuses_pending_inputs_and_upgrades_original_retry_identity` (rewinds to schema 17 and re-stages), and `a_downgraded_version_finishes_the_migration_on_reopen_and_stays_idempotent` (two consecutive reopens from `user_version=17` both end at the current schema with the session intact). Old product database → engine: `inactive_import_preserves_exact_bundle_and_survives_close_reopen_abort`. **A process killed mid-migration is not simulated**: resumability rests on the whole migration running inside one `BEGIN IMMEDIATE` transaction in `store.rs`, and that is the reason this row is not a ✓ |
| concurrent process migration claims are constrained across processes | `cargo test --test concurrent_open` | 3 passed, all with real child processes: `a_second_process_can_open_the_same_database` (the second runtime waits out the `fs2` migration lock and keeps serving instead of dying with `Busy`), `concurrent_admits_from_two_processes_do_not_lock` (20 interleaved admits spread over two processes), `startup_recovery_skips_sessions_with_a_live_lease` (a live lease is not adopted, an expired one is) |
| an incompatible old version explicitly refuses writes, with a backup and verification path before an upgrade | `cargo test --test catalog --test export --test doctor` and `cargo test --bin miao -- backup` | refusal, 6 + 2 + 3 passed: `catalog_never_creates_a_missing_database_or_migrates_an_unrelated_one` leaves a `user_version=9999` database byte-for-byte untouched and creates nothing, `unrelated_or_future_database_is_not_adopted` asserts the message names a newer `miao-engine` and the schema this binary supports, `diagnostic_rejects_unrelated_future_and_missing_databases_without_adoption`. Backup and verification, 1 passed: `miao db backup` copies through `VACUUM INTO`, copies the referenced blobs, reads the copy back with `PRAGMA integrity_check`, and refuses an existing target (#2485) |

## DATA-02 — relocation, import/export and history references

| criterion | command | observed |
| --- | --- | --- |
| covers TS-history-to-native conversion, native directory/workspace moves, forks and large attachments | `cargo test --test transfer --test transfer_history --test transfer_move --test workspace_transfer --test fork_identity` | 6 + 3 + 1 + 2 + 2 passed. Conversion: `native_display_archive_pages_canonical_messages_and_remaps_context_cuts`, `canonical_timeline_paging_and_context_selection_preserve_original_json`, and `preparation_preserves_selected_messages_media_times_and_tool_correlation` for media, times and tool correlation. Moves: `move_export_stages_into_a_fresh_location`, `workspace_move_keeps_an_explicit_model_selection_over_prior_identity`, `workspace_move_recovers_default_model_from_committed_assistant_identity`. Forks: `fork_keeps_parent_identity_and_read_only_mode`, `copied_user_prompts_are_promoted_exact_retries_not_new_work`. **Two things are not covered by any case here**: a *transfer* of a forked session (the fork cases run on the fork itself, not through a move), and an oversized blob-backed attachment travelling with a move |
| operations are split into stage/validate/activate and verify checksums and identity | `cargo test --test transfer_stage --test transfer_activation` | 3 + 4 passed: `host_preflight_and_atomic_prepared_stage_use_small_file_control_frames`, `corrupt_or_unsupported_file_fails_before_any_target_mutation` (validation refuses before the destination is touched), `actual_product_cas_is_required_and_activation_restores_provider_context_and_state` (the content address is required and activation restores provider context and state), `a_session_born_native_exports_its_whole_timeline_without_a_transfer_import`, `a_delta_export_for_an_unknown_session_still_conflicts` |
| a failure leaves neither dual ownership nor a lost source reference | same, plus `--test transfer` | `activation_failure_rolls_back_the_gate_and_every_provider_row`, `failed_preparation_insert_rolls_back_target_bundle_and_catalog`, `malformed_or_conflicting_import_never_changes_existing_destination`, `display_archive_rejects_unknown_source_ids_before_staging_a_session` |

## Still unaccepted after this record

- DATA-01: a migration interrupted by a killed process. The transaction makes it
  recoverable, but no case kills one, so the criterion is not claimed.
- DATA-02: a forked session through a transfer, and a blob-backed large attachment
  through a move.

Both gaps are named work, not completion claims. Everything else in the two items is a
✓ above with the command that printed it.
