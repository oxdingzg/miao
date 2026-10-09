# M0/M1 scenario map

Every scenario runs against deterministic provider fixtures (a local TCP
endpoint), so it is reproducible without a network or a live model. File paths
are relative to `crates/miao-engine/tests/`.

## M0b gate — deterministic and fault scenarios

| # | Scenario | Test |
|---|---|---|
| 1 | Lost ack is an exact retry; conflicts do not change history | `store.rs::lost_ack_is_exact_retry_and_conflicts_do_not_change_history` |
| 2 | Turn cancel while the provider waits does not block other sessions | `runtime.rs::cancellation_is_handled_while_provider_is_waiting_and_does_not_block_other_sessions` |
| 3 | A lagging progress subscriber does not block completion | `supervision.rs::lagging_progress_subscriber_does_not_block_completion` |
| 4 | Replay to a watermark, then live, has no gap or duplicate (handoff) | `store.rs::replay_to_watermark_then_live_has_no_gap_or_duplicate` |
| 5 | Crash reconciliation keeps dispatched-unsettled work `unknown`, no replay | `supervision.rs::crash_reconciliation_preserves_unknown_running_state_without_replay` |
| 6 | A second runtime is refused by the store lease; recovery never repeats dispatch | `store.rs::lease_rejects_second_runtime_and_recovery_never_repeats_dispatch` |
| 7 | Cancel while an approval waits invalidates a late reply without dispatch | `approval.rs::cancel_while_waiting_invalidates_late_response_without_dispatch_or_unknown` |
| 8 | An admitted background job survives turn cancel | `jobs.rs::admitted_job_survives_turn_cancel_and_instruction_reads_do_not_wait_for_it` |
| 9 | Interrupted committed tool calls get `unknown` results without a rerun | `runtime.rs::interrupted_committed_tool_calls_have_unknown_results_without_rerun` |
| 10 | Exact retry repairs a pending wake but never replays promoted work | `lost_wake.rs::exact_retry_repairs_pending_wake_but_never_replays_promoted_work` |
| 11 | Headless stdio and `export` describe the same committed ledger end to end | `m0_acceptance.rs::headless_stdio_and_export_describe_the_same_ledger` |

## M1 direction — coding-workflow scenarios

The M1 gate tracks 30–50 scenarios plus a real small fix. Existing coverage that
counts toward it includes conditional writes (`mutations.rs`), V4A patch
transactions (`apply_patch.rs`), sandboxed process execution and descendant reaping
(`process.rs`, `guardian.rs`), approval binding and cancellation (`approval.rs`,
`permission.rs`), provider fallback with a shared retry budget (`routing.rs`),
opaque-reasoning preservation (`responses.rs`), and MCP cancellation
(`mcp.rs`). The remaining M1 capabilities (PTY, LSP core, media, delegation) add
their own scenarios as they land.
