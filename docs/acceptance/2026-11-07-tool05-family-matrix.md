# Acceptance record — TOOL-05 output budget matrix across tool families

Item: `TOOL-05`. Tree: `9f56d83eaa`. Commands ran on the Linux build host from
`crates/miao-engine`. Every suite is Rust.

## What this record adds

The 2026-11-05 TOOL-05 record accepted its criteria but ended on a named hole: no
case ran a deliberately runaway command to its memory bound. That hole was already
closed — `tests/process.rs` had the runaway case before that record's tree — so this
record supersedes that paragraph, fills the matrix row it implies, and adds the one
surface no earlier record pinned: the `read` window budget
(`crates/miao-engine/tests/read_range.rs`, new on this tree).

## The matrix

| family | budget surface | command | observed |
| --- | --- | --- | --- |
| read | whole-file reads keep the 32768-byte bound; a ranged window stays inside 32768 bytes and reports `truncated`; the ranged cap still refuses files over 1 MiB | `cargo test --test read_range` | `4 passed` |
| shell | a process whose output passes the limit is stopped with `reason: output_limit`, exactly 32768 bytes retained, then SIGKILL | `cargo test --test process` | `10 passed` |
| terminal | retained output lives in a 1 MiB ring that reports dropped bytes; reads are bounded windows | `cargo test --test terminal` | `5 passed` |
| grep / glob | result limit 1..500, long lines truncated at 512 chars, oversized output downgraded to a partial report | `cargo test --test search` | `5 passed` |
| web | 2 MiB body cap against a local server, 65536-character output truncation | `cargo test --test web` | `10 passed` |
| MCP | payloads over 65536 characters refused, 262144-byte wire frame cap, 65536-character discovery cap (duplex wire fixture) | `cargo test --test mcp` | `23 passed` |
| image | the image reader bounds file size at 4 MiB and rejects non-images | `cargo test --test media` | `6 passed, 1 ignored` (the ignored case is the live video-skill workflow) |
| archive | oversized tool output (over 65536 characters) is externalized out of the transcript and reads back whole | `cargo test --test blob_externalization` | `3 passed` |
| recall | archived outputs come back by handle through bounded windows | `cargo test --test recall` | `7 passed` |

## Superseded

**`2026-11-05-tool05-output-budgets.md`, criterion 3, "Not tested" paragraph —
superseded.** That record stated no test in its batch ran a deliberately runaway
command and argued the scenario from the ring bound and externalization alone. The
runaway case already existed as a test:
`excessive_output_stops_process_instead_of_unbounded_buffering`
(`crates/miao-engine/tests/process.rs:206`), which is in the matrix above — its
`observed` cell is the number that replaces the argument. What remains true from the
old record: the terminal ring bound and the externalization path are still pinned by
their own suites, and the read-side window budget is now pinned too.

## Open

- **web `timeout` has no dedicated test.** The parameter is bounded (1..=120,
  enforced at `crates/miao-engine/src/web.rs:206`; the tool schema declares
  minimum 1, maximum 120, default 30), but no suite exercises the bound — the
  timeouts in `tests/web.rs` are test-harness helpers, not assertions on the
  parameter. Every other budget surface in the matrix has a test; this one rests
  on the schema and the inline check only.
