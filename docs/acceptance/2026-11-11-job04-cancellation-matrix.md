# Acceptance record — JOB-04 slow tools, hangs and budget watchdogs: the cancellation matrix

Item: `JOB-04` (#1964). Tree: `878f2aa43f` (branch `feat/job04-wait-source`, parent
`origin/main` `23612e5a5b`). Commands ran on the Linux build host in a synced copy of
this tree, from the crate directories, `cargo 1.99.1`, debug profile. A reviewer runs
the same commands from the same directories anywhere.

The two earlier records (`2026-11-01-job04.md`, `2026-11-07-job04-backpressure-signal.md`)
accepted the status vocabulary and the backpressure signal but left two things open: the
cancellation matrix over slow tools, and the LSP half of "timeouts on slow tools". This
record re-runs the matrix on the current tree and closes the LSP gap with a bound that now
has a test behind it.

## What changed in this tree

`crates/miao-engine/src/lsp.rs` gained two unit tests. The bound they pin was already in
`Client::request` (a `wait` that returns `LSP <method> timed out`), but nothing held it in
place, so a request could have become an unbounded block again without a red test. The
second test pins the other half of cancellation: an abandoned request must leave the
per-server client usable for the next tool call.

## Criterion — "Enforce header deadlines, silence limits, and timeouts on slow tools without refilling retry budgets."

| surface | command (crate) | observed |
| --- | --- | --- |
| header deadline, stream silence, ping watchdog, and no refill of the retry budget on a real process | `cargo test --test first_event actual_native_process_bounds_headers_silence_and_pings_without_refilling_retry_budget` (`crates/miao-engine`) | `test result: ok. 1 passed; 0 failed; 1 filtered out; finished in 68.88s` |
| a language server that answers nothing cannot hold the tool open | `cargo test --lib lsp::` (`crates/miao-engine`) | `test result: ok. 7 passed; 0 failed; 444 filtered out; finished in 0.20s` — includes `a_server_that_never_answers_times_out_instead_of_holding_the_tool_open`: a fixture server completes the handshake, reads the `textDocument/hover` request, never answers, and the call returns `Error::Invalid("LSP textDocument/hover timed out")` inside a 5 s bound |

## Criterion — "Reap stalled child processes and worker handles cleanly on timeout or cancellation."

| block source | command (crate) | observed |
| --- | --- | --- |
| a spawned command's descendants on timeout and on cancel | `cargo test --test process timeout_and_cancel_reap_normal_descendants` (`crates/miao-engine`) | `test result: ok. 1 passed; 0 failed; 9 filtered out; finished in 9.82s` |
| a pending approval | `cargo test --test approval_lifetime` (`crates/miao-engine`) | `test result: ok. 3 passed; 0 failed; finished in 0.26s` — `settled_call_cancels_only_its_pending_approval_before_the_run_finishes`, `failed_approval_cancellation_rolls_back_tool_settlement`, `late_replies_cannot_grant_a_call_that_has_left_its_approval_boundary` |
| a delegated child | `cargo test --test subagent task_cancel` and `cargo test --test subagent cancelling_the_parent_run` (`crates/miao-engine`) | `1 passed; 0 failed` each — `task_cancel_settles_a_background_child_into_a_cancelled_terminal_state`, `cancelling_the_parent_run_settles_its_background_child` |
| an MCP call in flight | `cargo test --test mcp cancellation_after_dispatch_does_not_replay` (`crates/miao-engine`) | `test result: ok. 1 passed; 0 failed; 22 filtered out; finished in 0.03s` |
| an LSP request in flight | `cargo test --lib lsp::` (`crates/miao-engine`) | `a_cancelled_request_leaves_the_connection_usable`: the first call is abandoned while the server stays silent, and the next call on the same client is answered (`{"ok":true}`) — cancellation neither wedges the client mutex nor strands the transport |

## Criterion — "Display wait reasons when execution blocks on approvals, backpressure, MCP, LSP, or subagents."

| block source | command (crate) | observed |
| --- | --- | --- |
| approvals and questions, and their count | `cargo test --lib several_blocking` (`crates/miao-tui`) | `test result: ok. 1 passed; 0 failed; 623 filtered out` — `several_blocking_requests_are_counted_in_the_status` renders `needs approval · 2 waiting`, `needs an answer · 2 waiting`, and `needs you · 1 approval · 1 question` |
| engine backpressure, ranked below an operator wait | `cargo test --lib backpressure` (`crates/miao-tui`) | `test result: ok. 6 passed; 0 failed; 618 filtered out` — includes `an_operator_blocking_wait_outranks_a_backpressured_engine` and `keys_still_execute_while_an_engine_backpressure_flood_pours_in` |
| MCP, LSP and subagent tools are named by the call that blocks | `cargo test --lib mcp_lsp_and_subagent_waits_are_named_by_the_tool_that_blocks` (`crates/miao-tui`) | `test result: ok. 1 passed; 0 failed; 623 filtered out` — `mcp__github__create_issue` shows `Running github/create_issue`, `lsp_diagnostics` shows `Running lsp_diagnostics`, `task` shows `Running task` |
| a long tool wait is not reported as a silent engine | `cargo test --lib silent_engine` (`crates/miao-tui`) | `test result: ok. 2 passed; 0 failed; 622 filtered out` — `a_silent_engine_is_called_out_without_claiming_failure`, `a_running_tool_is_not_reported_as_a_silent_engine` (the latter with a tool running for 300 s and no alert) |

## Criterion — "Link implementation PR, offline or real client acceptance records, and applicable versions; attach quality, cost, or latency evidence for optimizations."

This record is the offline half: pull request for tree `878f2aa43f`, the commands above,
and the two predecessor records. It is not a whole-crate re-verification — CI runs the
crates' full suites on this pull request, and those results are the suite-level evidence.

## What this record does not claim

- No real terminal was driven for the status text: the TUI rows are pinned by unit tests
  that render the widget, not by a tmux or Windows Terminal session. UX-04 owns that
  matrix.
- The LSP bound is exercised against a duplex fixture, not a real `rust-analyzer`. The
  real-server suite (`crates/miao-engine/tests/lsp.rs`) skips itself without the servers
  installed on the host.
- No latency comparison is claimed: JOB-04 changes no hot path, so there is nothing to
  measure against.
