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

A record that has drifted from the tree is worse than no record: `2026-11-01-perf04.md`
carries the table of filters that were re-run to keep the earlier records honest.
