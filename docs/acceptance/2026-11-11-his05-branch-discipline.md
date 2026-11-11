# Acceptance record — HIS-05 closed-loop review and verification receipts: branch discipline

Item: `HIS-05` (#1985). Tree: the pull-request head for branch `feat/issue1985`
(PR #2852), commit `9e37eda9c8`, parent `origin/main` `3fdf81b016`. Commands ran from
`crates/miao-engine` on the macOS build host in a synced copy of this tree,
`cargo 1.99.1`, debug profile, and the same tree's CI run
[`42933518854`](https://github.com/oxdingzg/miao/actions/runs/42933518854) is green.
A reviewer runs the same commands from the same directory anywhere. The commit that
carries this record changes only this file and one comment, so the run for the branch tip
is reported on the pull request rather than re-recorded here; the branch was afterwards
rebased onto `origin/main` with no conflicts, so the tree those commands ran on is the
patch this pull request carries.

The earlier record `2026-11-11-his05-verification-receipts.md` (#2846) accepted the
`review` state on every completion receipt and named one part of the third criterion as
**not enforced**: "it does not parse a refspec, and it does not refuse a
`git push origin main` on its own. That stays with the operator's approval." This record
closes that gap and re-runs the receipt evidence on this tree.

## What this tree adds

`crates/miao-engine/src/branch_discipline.rs` derives, from the words the shell is about
to execute, which branch a landing action would move:

- `git push` refspecs in every spelling that names a branch — `main`,
  `refs/heads/main`, `HEAD:main`, `+main`, `origin feat/x main`, `-d main`,
  `--delete origin refs/heads/main` — plus `--all`, `--mirror` and `--branches`,
  which move every branch at once;
- `gh pr create` `--head`/`-H`/`--head=`, so a pull request cannot come from the
  protected branch itself;
- and, only when the command names no branch, the branch the workspace checkout
  records in `.git/HEAD`.

The permission gate (`crates/miao-engine/src/runtime.rs`, the `Decision::Ask` arm) refuses
a finding that lands on `main` or `master` and records
`permission_denied {reason: "branch_discipline", action, target}` instead of raising an
approval prompt. A configured allow rule and a projected saved allow rule both return before
that point, because an explicit standing authorization is not the thing the engine is
substituting for; the floor deliberately precedes the durable-grant check, so a grant
recorded before it existed cannot lift it either.

A target the engine cannot observe keeps its ordinary ask, so an unreadable checkout can
never fabricate a refusal: a detached checkout, a linked worktree (whose `.git` is a file
pointing outside the workspace), `git -C`/`--git-dir`/`--work-tree`, `cd sub &&`, `HEAD`
or `x:` refspecs that name no branch, `--dry-run`/`-n`, and `--tags` alone.

## Criterion — "Connect concrete diffs with corresponding test evidence through the review workflow."

Carried by #2846 and re-run on this tree; this change does not alter it.

| surface | command | observed |
| --- | --- | --- |
| a receipt names the files a run wrote, with their hashes, on both sides of the check, and binds them to the task revisions | `cargo test --test verification` | `test result: ok. 6 passed; 0 failed` — including `a_zero_exit_cannot_validate_a_tracked_revision_changed_during_the_check` and `a_check_is_bound_to_the_task_revision_it_started_with` |
| the review state is derived from those observations rather than asserted | `cargo test --lib verification::` | `test result: ok. 3 passed; 0 failed; 459 filtered out` |

## Criterion — "Distinguish among issues found, fixed, verified, and unverified states."

Carried by #2846 and re-run on this tree.

| state | command | observed |
| --- | --- | --- |
| the pure derivation, including that repeated failures stay `found` and a cancelled check is never `verified` | `cargo test --lib verification::` | `3 passed` — `a_receipt_state_is_derived_from_the_executed_check`, `a_cancelled_check_never_verifies_a_source`, `the_snapshot_names_the_state_and_the_observation_behind_it` |
| `found` then `fixed` on a real run, and `verified`/`unverified`/`found` on the other paths | `cargo test --test verification` | `6 passed` — `a_failed_check_then_a_repair_is_reviewed_as_fixed` reads the two receipts as `["found", "fixed"]`; `a_passing_completion_check_lets_the_run_finish` asserts `verified`; `cancellation_records_an_unaccepted_receipt_without_admitting_a_repair_prompt` asserts `unverified` |

## Criterion — "Enforce project authorization and branch discipline during commit and PR actions without substituting text claims for actual execution."

The decision is read from the command that will run and from the checkout on disk; no
prose can set it, and no approval prompt can overrule it.

| surface | command | observed |
| --- | --- | --- |
| a push naming the protected branch is refused by the engine, with no approval prompt and no dispatch | `cargo test --test branch_discipline` | `4 passed` — `a_push_that_names_the_protected_branch_is_refused_without_a_prompt` asserts `permission_denied` with `reason == "branch_discipline"`, `action == "push"`, `target == "main"`, and that neither `approval.requested` nor `tool.dispatched` appears |
| a bare `git push` is judged by the branch the checkout records | same run | `a_bare_push_is_judged_by_the_recorded_branch` — the same words are refused when `.git/HEAD` says `main` |
| the refusal follows the observed branch, not the command shape | same run | `the_same_push_from_a_topic_branch_stays_an_explicit_ask` — the same shape names `feat/topic` and stays an `approval.requested` |
| a project's own allow rule still authorizes the call | same run | `an_operator_allow_rule_still_authorizes_the_push` — an allow-listed `bash` reaches `tool.dispatched` and records no denial |
| refspecs, bulk pushes, `--all`, `--delete`, `gh pr create` heads, and argv commands resolve to the branch they would move; unobservable targets stay an ask; commands that land nothing are not findings | `cargo test --lib branch_discipline::` | `test result: ok. 7 passed; 0 failed; 455 filtered out` |
| a commit, a push or a branch-creating git command is still never auto-approved, while read-only git stays `Safe` | `cargo test --lib agent_classifier` | `test result: ok. 4 passed; 0 failed; 458 filtered out` — `bash("git push") == Unknown`, `bash("git branch work") == Unknown`, `bash("git status; git log --oneline") == Safe` |

What this criterion still does not claim:

- A local `git commit` on a protected branch is **not** refused. It writes nothing to a
  remote, and refusing it would break a plain single-branch repository; it stays an
  explicit operator question, which the classifier already forces.
- The remote is not resolved to a URL: the engine reads the refspec, so any remote name or
  URL is judged by the destination branch. Bypasses outside the shell — `git send-email`,
  a `gh api` ref update, a host-side force push — are not covered.
- Branch protection on the hosting side remains the hosting side's rule; this makes the
  engine refuse rather than rely on it.

## Criterion — "Link the implementation PR with offline and live client acceptance records and target versions, including quality, cost, or duration evidence if optimized."

| part | value |
| --- | --- |
| implementation PR | #2852 (`feat/issue1985`), body opens `Implements HIS-05 (#1985): …` |
| offline record | this file, with the receipts record it builds on |
| CI tree | run [`42933518854`](https://github.com/oxdingzg/miao/actions/runs/42933518854) on `9e37eda9c8` |
| target version | none claimed: no release contains this tree yet |
| quality / cost / duration | none claimed: this change optimises nothing, so there is no measurement to attach |
| live client acceptance | not exercised here — see below |

## What this record does not claim

- No live terminal session was driven: the refusal is an engine event, and how the TUI
  renders `permission_denied` for a branch-discipline refusal was not watched.
- Windows behaviour of the gate is unexercised on this host; the CI Windows leg only
  compiles.
- A linked worktree whose `.git` is a file keeps its bare `git push` an ask rather than a
  refusal; only an explicit refspec is refused from there.
