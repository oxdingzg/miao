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

Accepted for the offline codec matrix; the live-provider leg stays open. The loop
guard sits in the engine's shared stream reader and observes the deltas each codec's
frames normalize into (`src/delta.rs`), so the matrix question is whether every
codec's looping wire trips the guard and whether every codec's malformed tool input
reaches the same bounded correction. The commands ran on the Linux build host from
`crates/miao-engine` on the tree that carries the two extensions below — the
test commit `281461f7d3` on this branch (main `3e476a2957` plus the tests; the
later commits here touch documentation only).

| command | observed |
| --- | --- |
| `cargo test --test output_guard the_guard_stops_a_looping_provider_stream` | ok — the same replay (40 refrain deltas, then a late tool call) now runs through all four streaming codecs — anthropic, openai-chat, openai-responses, gemini — and each codec's turn fails with `output.repetition`, dispatches no `tool.completed`, sends one provider request, and is not retried |
| `cargo test --test tool_input_recovery gemini_wire_correction_settles_invalid_arguments` | ok — through the Gemini codec: the completed `write_file` stays on disk, the malformed call settles `invalid tool input: read_file requires path`, the rejection reaches the model's next request, the corrected call recovers the turn with `RECOVERED`, three requests total |
| `cargo test --test tool_input_recovery` | `5 passed` — the two truncated-JSON budget tests keep their three-codec loop (anthropic, openai-chat, openai-responses), plus `provider_executed_calls_are_never_corrected_or_dispatched` and `unregistered_calls_are_corrected_within_the_same_budget_and_never_dispatched` |
| `cargo test --test output_guard` | `3 passed` |

**Why the matrix is shaped this way.** The Gemini codec carries tool arguments as
parsed JSON objects, so truncated-JSON arguments are structurally impossible on its
wire: the codec itself rejects a malformed `functionCall` part before the engine sees
it, which `tests/gemini.rs::malformed_truncated_blocked_and_duplicate_calls_never_become_replies`
already pins. Its malformed-input flavor is therefore schema-invalid arguments, and
that flavor settles the same corrective result the other codecs produce for
unparseable ones. The correction budget stop (`tool.input_recovery.stopped`,
`reason: "correction_budget"`) consequently stays exercised through the three codecs
that can carry truncated arguments, and the loop-guard matrix covers all four.

**Recorded open, not hidden:** the matrix runs against wire fixtures, not live
provider accounts, and the compiled-client presentation of a stopped loop is not
covered by any command above (the transcript-rendering side is TUI-04's record).

Result: criteria 1–3 **accepted**; criterion 4 accepted for the cross-provider codec
matrix, with the live-provider leg and the compiled-client presentation recorded
open on the item.
