# Acceptance record — TOOL-01 bounded retrieval

Item: `TOOL-01`. Tree: `e943537ff2`. Commands ran on the Linux build host from
`crates/miao-engine`. Every suite below is Rust (`crates/miao-engine/tests`); nothing in
this record depends on the retiring TypeScript tree.

## Criterion 1 — budgets and source tracking across windows, filters, ignore rules, and LSP queries

| surface | what is pinned | command | observed |
| --- | --- | --- | --- |
| read windows | a line window returns only that range plus whole-file metadata; a large file is readable through a window but **not** wholesale; a zero offset or limit is rejected | `cargo test --test read_range` | `3 passed` |
| read batches | native reads dispatch together and settle in call order; a long read prefix keeps the bounded parallel prefix with an ordered remainder; a denied read keeps its policy result; cancellation settles every dispatched read without `unknown` results | `cargo test --test read_batch` | `10 passed` |
| grep/glob filters | workspace paths and line previews without a shell; denied, asked, symlinked and engine files are excluded from results; output limits report partial results and long lines stay bounded; an invalid regex, glob, scope or limit fails **before** the search runs | `cargo test --test search` | `5 passed` |
| workspace bound | a read is bounded and cannot escape the workspace | `cargo test --test tools` | `1 passed` |

Restated honestly: the LSP half of this criterion is **not** accepted. `lsp.rs` refuses a
call hierarchy larger than its result budget ("LSP call hierarchy exceeds result budget"),
but no test pins that refusal, and `tests/lsp.rs` covers query mechanics and parameter
rejection only. A budget with no test is a claim, not evidence.

## Criterion 2 — no repeated full-file reads

The mechanism the criterion asks for is present and pinned: large files are reachable only
through windows (`a_large_file_is_readable_through_a_window_but_not_wholesale`), and edits
are fingerprint-bound, so a stale read is refused rather than silently re-read
(`tests/stale_edit.rs`, `tests/edit_recovery.rs`, `tests/tool_input_recovery.rs`).

Recorded as **partially accepted**: the window and fingerprint mechanisms are tested, but
nothing measures how often a task re-reads a file, so "avoid repeated full-file reads" as
an outcome is not claimed here.

## Criterion 3 — retrieval evaluated by accuracy, turn overhead and payload size

**Not accepted.** No run in this record measures localization accuracy, turn overhead or
payload size; those need the benchmark carrier and a budgeted real-provider run.

Result: criterion 1 accepted for read windows, read batches, grep/glob filters and ignore
rules (LSP result budget open); criterion 2 partially accepted; criterion 3 open.
