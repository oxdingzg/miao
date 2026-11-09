# Acceptance record — TUI-03 stream render states

Item: `TUI-03`. Tree: `e170b105ee` (the branch head; rebasing onto `main`
brought in INP-05's composer change, so this run covers both). Commands ran on
the Linux build host from `crates/miao-tui`; every suite below is the crate's
unit tests (`cargo test --lib`), and the full sweep on this tree is
`565 passed; 0 failed`. Nothing here depends on the retiring TypeScript tree.

## Criterion 1 — incremental text, reasoning, tool parameters and progress in T5

| surface | what is pinned | command | observed |
| --- | --- | --- | --- |
| streamed answer | text deltas land in the draft and paint before the turn commits | `cargo test --lib a_streamed_answer_appears_before_the_turn_commits` | `1 passed` |
| reasoning channel | reasoning deltas stream into a separate header (`Thinking · weighing`) and are not mistaken for the answer | `cargo test --lib reasoning_and_text_stream_into_separate_channels` | `1 passed` |
| engine-shaped frames | deltas wrapped the way the engine actually wraps them reach the painted draft, and every later delta appends | `cargo test --lib engine_shaped_deltas_reach_the_painted_draft` | `1 passed` |
| tool call and arguments | the call paints as soon as the engine opens it (rendered label, not the protocol name), and argument fragments split at arbitrary byte boundaries rejoin into the rendered command | `cargo test --lib tool_frames_paint_the_call_and_its_arguments` | `1 passed` |
| tool progress | the status line names the running tool while it runs (`Running bash · Esc interrupt`) | `cargo test --lib a_finished_run_retires_the_running_tool` | `1 passed` |

Restated honestly: the pinned manifold is the engine's *projected* stream
(`provider.delta` frames of kind `text.delta`, `reasoning.delta`, `tool.start`,
`tool.input.delta`). No live provider wire is exercised in this record, so a
provider whose chunking the engine projects differently is not covered.

## Criterion 2 — every state transition settles without duplicated output or a permanent running indicator

| surface | what is pinned | command | observed |
| --- | --- | --- | --- |
| commit replaces the stream once | the committed answer renders exactly once, the streaming draft is gone, and the draft's Thinking header retires with it | `cargo test --lib a_committed_turn_shows_the_answer_once_and_retires_the_stream` | `1 passed` |
| only the committing projection replaces | a projection event that does not commit the answer leaves the live draft alone | `cargo test --lib only_the_projection_that_commits_the_answer_replaces_the_draft` | `1 passed` |
| finished run retires the tool | once the run's projection lands, nothing is still running and the status returns to `Idle` — no permanent indicator | `cargo test --lib a_finished_run_retires_the_running_tool` | `1 passed` |

## Criterion 3 — history snapshots consistent with the live display; transparent and opaque reasoning separate

The committed turn in criterion 2 renders through `Transcript::from_snapshot` —
the same projection a history snapshot takes — so snapshot and live draft share
one rendering path, and the "renders exactly once" assertion is the consistency
check between them.

Transparent vs opaque reasoning is pinned at that projection boundary:
`cargo test --lib an_opaque_reasoning_block_keeps_its_header_facts` →
`1 passed`. An opaque block (an empty `text`, as Bedrock commits it) survives
as a reasoning part with no duration facts; a transparent block keeps its
`time.created`/`time.completed` for the duration header; prose stays prose.

Restated honestly: consistency is pinned as *one projection, one render, no
duplication* on this tree. A byte-for-byte diff between a re-opened history
snapshot's paint and the live paint is not measured here.

## Criterion 4 — implementing PR, verification record, version

The implementing PR is the branch `test/tui03-stream-render` (linked from the
PR description). This record is the offline verification. No release exists for
this tree yet, so per the repository convention the
`roadmap: CODE done in vX.Y.Z` stamp waits for the release; no real-client run
is claimed.

Result: criteria 1–3 accepted offline on `e170b105ee`; criterion 4 records the
offline half only. Open: a live provider stream manifold (chunking beyond the
engine projection) and a real-client run are not exercised by this record.

An identical test set ran earlier on the pre-rebase head `ef8b67a811`
(`559 passed; 0 failed`); every number above is the re-run on this tree.
