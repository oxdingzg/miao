# Acceptance record — TOOL-06 malformed tool input and output loops

Item: `TOOL-06`. Tree: `e67cfe8664`. Commands ran on the Linux build host from
`crates/miao-engine`.

## Criterion 1 — bounded corrective handling for malformed or unregistered input

A tool call whose arguments do not parse, or that names no registered tool, is corrected
inside one bounded allowance and never dispatched. The third malformed call stops the
correction loop and records `tool.input_recovery.stopped` with
`reason: "correction_budget"` (`crates/miao-engine/src/runtime.rs`), so a model that keeps
producing the same bad call cannot spend the Session.

| command | observed |
| --- | --- |
| `cargo test --test tool_input_recovery` | `4 passed` — `real_wire_correction_preserves_completed_write_and_durable_error_without_raw_arguments`, `changing_invalid_calls_cannot_bypass_the_two_correction_allowance`, `provider_executed_calls_are_never_corrected_or_dispatched`, `unregistered_calls_are_corrected_within_the_same_budget_and_never_dispatched` |

## Criterion 2 — repetitive output is detected, the partial reply is kept, execution halts before a late tool call

The stream guard watches text and reasoning deltas; a detected loop fails the turn
without retrying and without dispatching the tool call that arrived after the loop.

| command | observed |
| --- | --- |
| `cargo test --test output_guard` | `3 passed` — `the_guard_stops_a_looping_provider_stream_before_a_late_tool_call`, `a_stopped_loop_fails_the_turn_without_retrying_or_dispatching`, `an_earlier_loop_is_neutralized_in_the_provider_request_only` |
| `cargo test --lib output_guard::` | `10 passed` — single-line and alternating prose loops, four-phrase loops, a refrain interleaved with progress, CRLF and chunk-boundary invariance, and the ordinary-progress cases that must **not** trip the guard |
| `cargo test --test guarded_cancel` | `1 passed` — `stale_execution_ids_cannot_interrupt_the_new_run` |

## Criterion 3 — the loop is neutralized in provider-facing history only

`output_guard::neutralize` runs on the history copy a request is built from
(`runtime.rs`, "Durable rows are untouched"), replaces looped assistant text and
reasoning, and drops the reasoning signature with it because the replacement did not
authenticate it. `an_earlier_loop_is_neutralized_in_the_provider_request_only` asserts
both halves: the request carries the neutralized note, the durable transcript keeps what
the operator saw.

## Criterion 4 — cross-provider matrix

**Not accepted.** These runs exercise the engine's own guard and correction paths through
the real wire fixtures, but no matrix across live providers is claimed here, and the
compiled-client presentation of a stopped loop is not covered by any of the commands
above.

Result: criteria 1–3 **accepted**; criterion 4 stays open on the item.
