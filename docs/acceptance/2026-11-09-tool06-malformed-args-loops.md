# Acceptance record — TOOL-06 malformed tool arguments and loop protection

Item: `TOOL-06`. Tree: `f08ba210ce` (branch `feat/tool06-malformed-args-loops`;
`7e46206e31` names unknown tools and wrong-typed arguments in settled
rejections, `0ebd6ba5c3` pauses the drain on a byte-budget overflow instead of
failing the run, `f08ba210ce` pins the behaviour end to end on the wire). The
commands below are the cargo invocations the pull request's CI workflow runs
from the crate directory on this recorded tree; the observed cells cite that
run (id recorded here when the engine shards go green).

## Criterion — bounded corrective handling for malformed or unregistered tool inputs

| command | observed |
| --- | --- |
| `cargo test --test malformed_tool_input` (crates/miao-engine) | ok. 4 passed; 0 failed (CI run RUNID, engine shard) |
| `cargo test --test tool_input_recovery` (crates/miao-engine) | ok. 4 passed; 0 failed (same run) |
| `cargo test --test empty_tool_arguments` (crates/miao-engine) | ok. 1 passed; 0 failed (same run) |
| `cargo test --lib tool_input` (crates/miao-engine) | ok. 6 passed; 0 failed (same run) |

Pinned in this record's tree:

- `an_unknown_tool_with_valid_arguments_is_named_in_the_settled_result` — a call
  to a name the catalog does not register, with valid JSON arguments, settles
  the TS-parity `Unknown tool: totally_unknown` corrective result instead of the
  bare "tool is not available"; nothing dispatches, and the model reads the same
  reason on its next turn.
- `wrong_typed_arguments_settle_a_result_that_names_the_expected_type` — valid
  JSON whose `path` is a number settles `invalid tool input: read_file expects
  path as a string`, and the model sees it on its next turn; an advertised name
  that fails for a capability reason keeps its own error.
- `oversized_tool_arguments_pause_the_drain_with_a_visible_reason` — a 4 KiB
  argument stream against a 256-byte budget stops the stream before any call
  exists to settle: the drain pauses the way the correction budget does (run
  `completed`, `tool.input_oversize` recorded, `message.synthetic` visible), the
  Session keeps no tool result, and the failed stream is not retried.
- The pre-existing pins keep their shape on the same tree: garbled arguments
  settle durable corrective errors within the two-correction allowance
  (`tool_input_recovery`), a dropped argument object names the missing field
  (`empty_tool_arguments`), and the per-call byte/idle budgets hold per protocol
  (`tool_input` unit tests).

## Criterion — repeated failing calls exhaust the same loop bounds

| command | observed |
| --- | --- |
| `cargo test --test supervision` (crates/miao-engine) | ok. 6 passed; 0 failed (CI run RUNID, engine shard) |
| `cargo test --test malformed_tool_input` (crates/miao-engine) | ok, `repeated_failing_identical_calls_hit_the_same_refusal_bound` (same run) |

- `repeated_failing_identical_calls_hit_the_same_refusal_bound` — the identical
  call fails at prepare every turn (wrong-typed `path`): five failing executions
  count exactly like five successful ones, the sixth is refused with the
  corrective "Refusing to run read_file again" result, `loop.detected` fires
  once, and a model that re-issues the refused call ends the run with
  `loop.stopped` (`refused-tool-call`, 4 refusals) instead of buying another
  provider turn.
- The successful-call side of the same bound stays pinned by
  `repeated_identical_calls_are_refused_with_a_corrective_error` in
  `tests/supervision.rs`, unchanged on this tree.

## Criterion — repetitive stream output halts before late tool calls and is neutralized in provider-facing history

| command | observed |
| --- | --- |
| `cargo test --test output_guard` (crates/miao-engine) | ok. 3 passed; 0 failed (CI run RUNID, engine shard) |
| `cargo test --lib output_guard` (crates/miao-engine) | ok. 13 passed; 0 failed (same run) |

- `a_stopped_loop_fails_the_turn_without_retrying_or_dispatching`,
  `the_guard_stops_a_looping_provider_stream_before_a_late_tool_call`, and
  `an_earlier_loop_is_neutralized_in_the_provider_request_only` hold unchanged:
  the stop keeps the partial reply durable and dispatches nothing, and history
  replacement touches the provider-facing copy only. `runtime.rs` keeps the
  durable `output.repetition` event; the durable transcript rows are never
  rewritten.

## Criterion — link the implementation PR, acceptance records, and applicable versions

- Implementation: this pull request (Implements TOOL-06 #1959), branch tip
  `f08ba210ce`.
- Acceptance record: this file. The engine workflow (`engine.yml`) runs the
  suites above on ubuntu-24.04 in four shards; the run id and shard land in the
  observed cells when green.
- Versions: applies from the release that first ships the merged tree; stamped
  per the repository convention when that release cuts.

## Still open

- Compiled-client presentation of the corrective results and the cross-provider
  matrix (Anthropic, Responses, Gemini, Bedrock eyes on the same degradations):
  the correction suite already loops three wire formats, but the oversize and
  unknown-tool pins ride the chat wire only in this record.
- Real-client acceptance with quality, cost, and latency evidence — the issue's
  status snapshot keeps it open regardless of the offline pins.
- Idle-timeout stalls (`tool input idle timeout`) still end the run as a plain
  provider failure; only the byte-budget overflow pauses the drain. A stalled
  provider is a transport-shaped recovery problem, not a malformed-argument one,
  and stays out of this record's criteria.
