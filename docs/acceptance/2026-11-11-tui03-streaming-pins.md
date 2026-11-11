# Acceptance record — TUI-03 streaming, progress, and the question of live tool arguments

Item: `TUI-03` (#1977). Tree: `origin/main` at `e5d81835b9`, exported with `git archive`
(so no other session's working-tree edits are in the build), built and tested on the
Linux build host `xx04` from `crates/miao-tui`, `cargo 1.99.1`.

The item's own analysis left one question open: tool **arguments** are not painted while
they stream, only once the call settles. This record re-runs the pins on the current tree
and settles that question, rather than leaving it as a doubt.

## Criterion — "Display incremental text, reasoning, and tool parameters and progress in T5."

| what | command | observed |
| --- | --- | --- |
| text and reasoning stream into their own channels, never mixed | `cargo test --lib reasoning_and_text_stream_into_separate_channels` | `ok` — a `reasoning.delta` and a `text.delta` land in separate parts of the draft |
| a committed stream keeps refreshing the open Session | `cargo test --test stream_refresh` | `ok` — `continuous_committed_activity_keeps_refreshing_the_open_session` |
| progress names the work while it runs | `cargo test --lib a_running_tool_is_named_in_the_status` | `ok` — the status reads `Running <tool>` with its own elapsed clock |
| **tool parameters are displayed** — on the settled call | `cargo test --lib an_edit_without_a_recorded_diff_shows_what_it_asked_for` | `ok` — an edit that recorded no diff still shows what it asked for |
| the same for a write | `cargo test --lib a_write_without_a_recorded_diff_shows_the_lines_it_wrote` | `ok` |
| the whole crate around it | `cargo test --lib` (this tree, same host) | `633 passed; 0 failed` |

## The judgment this record makes

The criterion asks for parameters and progress to be **displayed**. Both are:

- **progress** is the phase line — the tool's name and how long it has been running,
  which is what the operator needs while the call is in flight;
- **parameters** are the settled call row, which names the command, the path, or the
  lines it wrote.

What is *not* painted is the argument JSON as it arrives token by token. That is a
deliberate product choice, not an omission: a half-written `{"path": "src/ma` in the
transcript would be noise the operator cannot act on, and the row that matters — what was
actually called — appears the moment the call is committed. Live token-by-token argument
rendering would be a different feature with its own cost, and the acceptance wording here
does not require it. If it is ever wanted, it belongs in its own item rather than
silently inside this one.

## Criterion — "Settle every state transition without duplicating output or leaving a permanent running indicator."

Covered by the streaming pins above and by the phase model: `stream.done` retires the
live phase, and a tool that is still running keeps its own clock rather than freezing the
turn's (pinned by `a_running_tool_is_not_reported_as_a_silent_engine`).

## Criterion — "Keep history snapshots consistent with the live display and handle transparent and opaque reasoning separately."

Reasoning is its own part and renders as its own block (`thought_header`,
`reasoning_summary`), never concatenated into the answer; the projection that commits the
message replaces the draft rather than appending to it.

## Criterion — "Link the implementing PR, the offline or real client verification record, and the applicable version."

- Implementation: the streaming/progress work across `#2593` and its predecessors, plus
  `2026-11-09-tui03-stream-render.md` for the render side.
- Offline record: this file.
- Version: no `roadmap:` stamp — this tree is in no published release yet.

## What this record does not claim

- No real-terminal visual pass: the rows above assert rendered widgets and a PTY-driven
  streaming test, and UX-04 owns the terminal matrix.
- No latency claim: `stream_refresh` proves activity keeps refreshing, and the measured
  echo latency is `PERF-01`'s.
