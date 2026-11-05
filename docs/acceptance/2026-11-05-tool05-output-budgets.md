# Acceptance record — TOOL-05 tool output budgets, handles and text safety

Item: `TOOL-05`. Tree: `9b3aca3eb1`. Commands ran on the Linux build host from
`crates/miao-engine`. Every suite is Rust.

## Criterion 1 — size, timeout and long-line boundaries across the tool families

| family | what is pinned | command | observed |
| --- | --- | --- | --- |
| shell / terminal | stop and shutdown reap processes and bound the retained output ring | `cargo test --test terminal` | `5 passed` |
| grep / glob | output limits report a partial result and long lines stay bounded; an invalid regex, glob, scope or limit fails before the search | `cargo test --test search` | `5 passed` |
| web | the body bound, redirects, credential refusal and cancellation | `cargo test --test web` | `10 passed` |
| MCP | a configured request timeout is bounded and never replays the call; a silent stdio server is bounded by its startup timeout; a large catalogue folds to the discovery pair | `cargo test --test mcp` | `23 passed` |
| image | the image reader bounds file size and rejects non-images | `cargo test --test media` | `6 passed, 1 ignored` (the ignored case is the live video-skill workflow) |

## Criterion 2 — bounded previews, raw content by handle, no split UTF-8

- Previews stay bounded (`search`'s output-limit case) and recall returns unicode previews
  with a stable cursor (`recall_literal_queries_have_stable_cursor_and_unicode_previews`).
- Raw content survives outside the transcript and comes back by handle:
  `an_archived_tool_output_comes_back_by_handle_across_bounded_windows` and
  `archived_handle_scan_resumes_after_compaction_and_reopen` (`cargo test --test recall`,
  `7 passed`).
- Chunk-boundary safety is pinned in `output_guard`'s
  `is_invariant_to_crlf_and_unicode_chunk_boundaries` (part of `cargo test --lib
  output_guard::` → `10 passed`).

## Criterion 3 — runaway commands and oversized responses cannot exhaust memory

`cargo test --test blob_externalization` → `3 passed`:
`an_oversized_payload_stays_out_of_the_ledger_and_reads_back_whole` (an oversized tool
result is externalized instead of being held in the transcript),
`gc_takes_orphans_after_truncation_and_never_touches_live_references`, and
`the_disk_curve_is_reported_as_numbers`.

The engine also bounds the *command* side: terminal output is retained in a bounded ring
that reports dropped bytes and truncation (`crates/miao-engine/src/terminal.rs`), which
`terminal_stop_and_shutdown_reap_processes_and_bound_output` exercises.

**Not tested:** no case in this batch runs a deliberately runaway command (`yes`-style) to
its memory bound. The ring bound and the externalization path are pinned; the "runaway
process" scenario is argued from those two, not measured.

Result: criteria 1–3 accepted on the evidence above, with the runaway-command scenario
named as untested rather than assumed.
