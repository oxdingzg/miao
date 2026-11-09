# Acceptance record — TOOL-01 LSP result budget

Item: `TOOL-01`. Tree: `e4e9996cf6`. Commands ran on the Linux build host from
`crates/miao-engine`. This record closes the gap `2026-11-05-tool01-bounded-retrieval.md`
left open: the LSP call-hierarchy result budget had an implementation but no test.

## Criterion 1 — budgets and source tracking across windows, filters, ignore rules, and LSP queries

The LSP half is now pinned by
`the_call_hierarchy_bounds_reject_oversized_and_runaway_results` (`tests/lsp.rs`), which
drives a fixture language server whose answers overflow exactly one bound per queried
line:

| surface | what is pinned | command | observed |
| --- | --- | --- | --- |
| LSP result budget | two prepared roots, each answered with 125 call items of ~350 bytes — a single reply is ~44 KB, under the wire cap, but the accumulated ~88 KB crosses 64 KiB and is refused with the exact `LSP call hierarchy exceeds result budget` error instead of reaching the model; the same test pins 300 accumulated calls against the 256-call result limit and 17 prepared roots against the 16-root item limit | `cargo test --test lsp the_call_hierarchy_bounds_reject_oversized_and_runaway_results` | `ok` |
| wire 64 KiB cap | the fixture splits the oversized result across two replies so the budget refusal is proven to be the accumulated-budget path: the test asserts exact error strings, so a reply crossing the per-response cap (`LSP result exceeds 64 KiB`, `src/lsp.rs`) would fail the test before the budget check could fire | `cargo test --test lsp` | `8 passed; 0 failed; 1 ignored` |

The one ignored test is the pre-existing rust-analyzer round trip, which stays
explicit-run only. The other five suites behind this criterion were re-run on the same
tree to keep the older record honest: `read_range` `3 passed`, `read_batch` `10 passed`,
`search` `5 passed`, `tools` `1 passed`, `stale_edit` `1 passed` — `0 failed` everywhere.

Criterion 1 is accepted in full.

## Criterion 2 — no repeated full-file reads

Unchanged from `2026-11-05-tool01-bounded-retrieval.md`: the window and fingerprint
mechanisms are tested, but nothing measures how often a task re-reads a file. Still
**partially accepted**.

## Criterion 3 — retrieval evaluated by accuracy, turn overhead and payload size

**Open.** Still needs the benchmark carrier from #1948 and a budgeted real-provider run.

Result: criterion 1 accepted (the LSP result budget is pinned, the wire cap respected);
criterion 2 partially accepted; criterion 3 open on #1948.
