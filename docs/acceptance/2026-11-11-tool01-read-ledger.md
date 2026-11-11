# Acceptance record — TOOL-01 minimal necessary reads and precise retrieval

Item: `TOOL-01`. Tree: PR #2832, squash merge of `feat/issue1953` on `main`.
The commands below are the cargo invocations the pull request's CI workflow
runs on ubuntu-24.04 from the crate directory on this recorded tree; the
observed cells cite the green run 42918281345 (engine shards after the
read-ledger scope fix).

## Criterion — enforce minimal necessary reads with precise retrieval

Every read a session performs lands in a durable read ledger; a repeat read
the ledger already covers is not re-delivered, and compaction clears the
scope so a reread delivers again. Precise retrieval and least-necessary reads
are pinned together in the read-ledger suite.

Pinned tests (green in run 42918281345):

- the ledger suppresses an exact repeat read
- a compaction clears the scope so a reread delivers again
- retrieval selects the precise span instead of the whole file

| command | observed |
| --- | --- |
| `cargo test --test read_ledger` | ok |
| `cargo test --test compaction_acceptance` | ok |

## Criterion 4 — link the implementation PR, acceptance records, and target versions

- Implementation: #2832.
- Acceptance record: this file.
- Versions: applies from v0.3.62 onward.

**Recorded open, not hidden:** the retrieval-quality harness against real
codebases (precision at scale) stays open per the issue.
