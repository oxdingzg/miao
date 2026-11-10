# Acceptance record — HIS-05 closed-loop review and verification receipts

Item: `HIS-05` (#1985). Tree: the pull-request head for branch
`feat/his05-verification-receipts`, parent `origin/main` `23612e5a5b`. Commands ran on
the Linux build host in a synced copy of this tree, from `crates/miao-engine`,
`cargo 1.99.1`, debug profile. A reviewer runs the same commands from the same directory
anywhere.

## What this tree adds

A completion check already recorded `verification.started` and `verification.completed`
with the source snapshot before and after the command, the task revisions on both sides,
`command_passed`, `accepted` and `cancelled`. What it did not do was say what the check
*meant* for review: a reader had to re-derive "is this fixed or merely claimed" from four
booleans, and a cancelled check read the same as an unrun one.

`crates/miao-engine/src/verification.rs` now derives a `Review` state from those
observations, and every `verification.completed` receipt carries it as
`review: {state, reason}`:

| state | derived from | meaning for a reviewer |
| --- | --- | --- |
| `verified` | the command passed, the source and task revisions did not move, and no earlier attempt failed | the evidence describes this tree |
| `fixed` | the same, but an earlier attempt in this run failed | a defect was found and the repair is what passes |
| `found` | the command ran and failed | a defect is on record against this source |
| `unverified` | cancelled, or the command passed at a source that moved | no evidence either way |

Only an executed command can set one of the four: there is no path from prose to
`verified`, because the state is computed from the exit status and the source snapshot.

## Criterion — "Connect concrete diffs with corresponding test evidence through the review workflow."

| surface | command | observed |
| --- | --- | --- |
| a receipt names the exact files a run wrote, with their hashes, on both sides of the check | `cargo test --test verification` | `test result: ok. 6 passed; 0 failed; finished in 31.78s` — every receipt carries `source_before`/`source_after` (`{"coverage":"native-write-targets","complete":…,"files":[{"path":…,"state":{"kind":"file","sha256":…,"bytes":…}}]}`) and `task_before`/`task_after` |
| a passing exit cannot validate a tree that changed while the check ran | same run | `a_zero_exit_cannot_validate_a_tracked_revision_changed_during_the_check` — a check that writes a tracked file exits 0 and is still not accepted |
| a check is bound to the task revision it started with | same run | `a_check_is_bound_to_the_task_revision_it_started_with` |
| the review state is derived from those observations, not asserted | `cargo test --lib verification::` | `test result: ok. 3 passed; 0 failed; 449 filtered out` |

## Criterion — "Distinguish among issues found, fixed, verified, and unverified states."

| state | command | observed |
| --- | --- | --- |
| all four states from the pure derivation, including that repeated failures stay `found` and a cancelled check is never `verified` | `cargo test --lib verification::` | `3 passed` — `a_receipt_state_is_derived_from_the_executed_check`, `a_cancelled_check_never_verifies_a_source`, `the_snapshot_names_the_state_and_the_observation_behind_it` |
| `found` then `fixed` on a real run: the check fails, the repair prompt lands, the model writes the file the check looks for, and the second receipt is `fixed` | `cargo test --test verification a_failed_check_then_a_repair_is_reviewed_as_fixed` | `1 passed` — the two receipts read `["found", "fixed"]` and `verification.passed` is recorded |
| `verified` on a first-try pass, `unverified` on a cancelled check, `found` on both attempts of a check that keeps failing | `cargo test --test verification` | `6 passed` — `a_passing_completion_check_lets_the_run_finish` asserts `review.state == "verified"`, `cancellation_records_an_unaccepted_receipt_without_admitting_a_repair_prompt` asserts `"unverified"`, `a_failing_completion_check_continues_once_then_closes_with_a_classification` asserts `["found", "found"]` |

## Criterion — "Enforce project authorization and branch discipline during commit and PR actions without substituting text claims for actual execution."

| part | command | observed |
| --- | --- | --- |
| a commit, a push or a branch-creating git command is not auto-approved: it is classified `Unknown` and therefore needs the operator's decision, while read-only git stays `Safe` | `cargo test --lib agent_classifier` | `test result: ok. 4 passed; 0 failed; 448 filtered out` — `readonly_bash_is_safe_and_mutating_or_opaque_bash_stays_unknown` pins `bash("git push") == Unknown`, `bash("git branch work") == Unknown`, `bash("git status; git log --oneline") == Safe`, and an unparsable command stays `Unknown` rather than being trusted |
| no claim can stand in for execution | `cargo test --test verification` | a receipt exists only when the command really ran (`verification.started` → `verification.completed`), and `accepted` requires a zero exit *and* an unchanged source *and* unchanged task revisions; the cancelled case is recorded as unverified rather than passed |

Branch discipline beyond "a push needs approval" is **not** enforced by the engine: it does
not parse a refspec, and it does not refuse a `git push origin main` on its own. That stays
with the operator's approval and with the project's own rules and hosting configuration.
This record does not claim otherwise.

## Criterion — "Link the implementation PR with offline and live client acceptance records and target versions, including quality, cost, or duration evidence if optimized."

This record is the offline half for the pull request that carries this tree; the engine
suites above are the evidence, and no release has shipped it yet, so no target version is
claimed. No optimisation is claimed, so no quality/cost/duration evidence is attached. The
live-client half — an operator watching a receipt in a running TUI session — is not
exercised here.

## What this record does not claim

- No real terminal session was observed: the receipt is an engine event, and how a client
  renders it was not driven.
- The review state describes one completion check, not a whole-repository review.
- Windows behaviour of the completion check is unexercised on this host.
