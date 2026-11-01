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
