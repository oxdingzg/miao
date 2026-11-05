# Acceptance records

An acceptance record answers one question: **can someone else reproduce the claim?**
It is not a status note, and it does not depend on a release existing.

## What a record contains

- **Item** — the roadmap code, e.g. `COST-04`.
- **Criterion** — one acceptance bullet, quoted, not paraphrased into something easier.
- **Command** — the exact command a reviewer runs, with any environment it needs.
- **Observed** — what that command printed, from a recorded run.
- **Tree** — the commit the run was made on.

## The two kinds of criterion

1. **Behaviour with a test behind it.** The command is the test; the record cites the
   suite and the count. A criterion with no test is not accepted by this record — it
   is named as unaccepted and why.
2. **Measurement.** The command is the harness; the record carries the numbers it
   printed, including the ones that miss a gate. A missed gate is recorded as missed.

## What "done" means here

An item is **accepted offline** when every criterion has a run that passes on the
recorded tree. The repository convention still adds `roadmap: CODE done in vX.Y.Z`
only when a release ships that tree, so an accepted item waits for the release stamp
and nothing else. Until then the record is the evidence, and an item with one
unaccepted criterion stays open.

Records are written per date, not per item, because one run produces the evidence for
several items at once.

## Index

One line per record: the tree its commands ran on, and the items it covers. A
record is the evidence for its own tree; when an item gains evidence later, the
newer record is the one to read.

| record | tree | items |
| --- | --- | --- |
| `2026-11-01-offline.md` | `acc8468d42` | VAL-03, PERF-01, PERF-03, INP-06, COST-04, CFG-01, COST-01, MEDIA-03, HIS-03, INP-03, TOOL-05 |
| `2026-11-01-tui-batch.md` | `a6b6501727` | UX-02, JOB-02, PERF-02 |
| `2026-11-01-tui-batch-2.md` | `e76064e87c` | JOB-05, UX-03 |
| `2026-11-01-inp07.md` | `b2e113d838` | INP-07 |
| `2026-11-01-ux05.md` | `9c64321659` | UX-05 |
| `2026-11-01-job04.md` | `a592266307` | JOB-04 |
| `2026-11-01-perf04.md` | `2cc8d13342` | PERF-04 (and a re-verification of every command the earlier records cite) |
| `2026-11-01-inp05.md` | `bc4dc86fcc` | INP-05 |
| `2026-11-04-config-ext-retry.md` | `04dc191a01` | CFG-02, CFG-03, MOD-05, EXT-01, EXT-04, EXT-05, EXT-06, EXT-07 |
| `2026-11-04-data-migration-transfer.md` | `04dc191a01` | DATA-01, DATA-02 |
| `2026-11-04-cli-entry-point.md` | `04dc191a01` and `2c35372277` | RUS-04 |
| `2026-11-05-cost05-doctor-report.md` | `d13b75a3ee` | COST-05 (doctor reports version, routing, sandbox mode in effect and each external program; log export and tracing overhead stay open) |
| `2026-11-05-his03-undo-and-snapshots.md` | `9b3aca3eb1` | HIS-03 (stage/clear/commit with undo and redo, history-only vs file rollback boundaries, outside-modification preview; the shell-side-effect disclaimer stays open) |
| `2026-11-05-rel04-completion-gate.md` | `4a5f9a9e0f` | REL-04 (audit and capability ledger; deletion blocked by the observation window) |
| `2026-11-05-val03-review-changes.md` | `a1239dff43` | VAL-03 (the reviewing-changes row `2026-11-01-offline.md` left unaccepted) |
| `2026-11-05-tool04-diagnostics-version.md` | `097e6717ee` | TOOL-04 (versions and staleness in the diagnostics payload, and the completion check's repair path) |
| `2026-11-05-tool05-output-budgets.md` | `9b3aca3eb1` | TOOL-05 (size/timeout/long-line bounds per tool family, bounded previews with handle retrieval, oversized payload externalization; a runaway-command case stays untested) |
| `2026-11-05-job02-background-tasks.md` | `db0b250ae6` | JOB-02 (job/shell/child listing, scoped cancel and stop, crash reconciliation; a subagent-suite flake is recorded as open) |
| `2026-11-05-tool01-bounded-retrieval.md` | `e943537ff2` | TOOL-01 (read windows, read batches, grep/glob filters and ignore rules; the LSP result budget and the retrieval measurement stay open) |
| `2026-11-05-cost03-cache-health.md` | `82d4e77eae` | COST-03 (recommendations for every unhealthy cache state; the TUI cache line stays open) |
| `2026-11-05-tool06-malformed-input-and-loops.md` | `e67cfe8664` | TOOL-06 (bounded correction for malformed calls, loop detection that halts before a late tool call, provider-only neutralization; the cross-provider matrix stays open) |
| `2026-11-05-tool07-web.md` | `37db1dc9c3` | TOOL-07 (source URL, body bound, redirects, credentials, cancellation) |
| `2026-11-05-cfg02-unknown-keys.md` | `82d4e77eae` | CFG-02 (unknown keys warned about with their source and closest known key; the managed scope stays open) |

A record that has drifted from the tree is worse than no record: `2026-11-01-perf04.md`
carries the table of filters that were re-run to keep the earlier records honest.

## When a record stops matching the code

A record is evidence for its own tree, not a promise about today's. When later work
removes the widget or test a row cites, the row is **annotated in place** rather than
deleted or silently left to look current:

> **Superseded** / **Not accepted — the claim was wrong.** …what changed, which commit
> changed it, and what remains true.

Three rows earned that treatment on 2026-11-03, found by checking every test name the
records cite against the source:

- `2026-11-01-ux-interaction-batch.md` — the list pointer rows cite
  `a_click_on_the_list` and `a_second_click_on_the_same_row`, which `#2431` removed
  along with the launcher list they drove.
- `2026-11-01-tui-batch-2.md` — an animation row argued the TUI paints no animation
  from a `grep` that returned 0 then and returns 7 now (the running-tool spinner).
- `2026-11-01-inp05.md` — a row claimed the Zed selection is visible in the composer
  and removable by editing. `App::zed_context` prepends it during `submit`, so the
  operator never sees it first.

The rule that follows: **a cited test name has to resolve**, and a claim about what the
code does has to be true of the code today. Re-verifying a record means running its
commands on the current tree, not reading its counts.
