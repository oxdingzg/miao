# Acceptance record — DATA-01 migration repeatability and interruption

Item: `DATA-01`. Tree: `main` at `c13275e9a6` (`#2676`). Commands ran on the
Linux build host (`x86_64-unknown-linux-gnu`) from `crates/miao-engine/` at
that tree.

## The criterion this record accepts

**Migration of the old product database and the engine database is repeatable
and resumable after interruption.** The session migration from the TypeScript
product store (`ts_to_rust`) is staged — `migration_stage` batches by source
sequence, `migration_cutover` freezes the source, `migration_complete` closes
it, `migration_abort` unwinds — and the suite pins the interruption paths:

- `migration_stage_cutover_complete_freezes_and_reopens_the_session`: the happy
  path, with the session frozen and reopened on the other side.
- `migration_abort_is_pre_cutover_only_and_exported_sources_remain_fenced`: an
  abort before cutover leaves the exported source fenced rather than half-read.
- `migration_refuses_pending_inputs_and_upgrades_original_retry_identity`: a
  migration does not run over pending inputs, and retried identities upgrade in
  place instead of duplicating.
- A mid-flight interruption is simulated directly: the test advances the
  journalled source sequence under the migration's feet
  (`UPDATE engine_migration SET source_high_seq = source_high_seq + 1`), then
  re-stages — the resume reconciles the gap instead of replaying or skipping.
- `a_downgraded_version_finishes_the_migration_on_reopen_and_stays_idempotent`:
  reopening under an older binary finishes the migration and a second pass is
  idempotent, which is the "repeatable" half of the criterion.

## Suites

| what | command | observed |
| --- | --- | --- |
| the migration suite | `cargo test --test migration` (from `crates/miao-engine/`) | `5 passed; 0 failed`, 1.00 s |
| concurrent-claim and downgrade-refusal criteria | accepted previously, re-run within the same suite | `migration_refuses_pending_inputs…` and `a_downgraded_version…` green |

## What this record does not claim

- The migration here is the engine store's session migration. The retired
  TypeScript product database itself no longer exists as a runtime (RUS-02);
  its rows reach the engine store through this staged migration, which is what
  the suite exercises.
- Windows unexercised, as before.
