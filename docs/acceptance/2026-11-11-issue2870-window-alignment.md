# Acceptance record — #2870 the pause is aligned with the window it is not

Issue: #2870 ("budget reminder out of step with real context usage: cumulative billed
tokens vs the model's window, reported as 'budget exhausted'"). Tree: the code commit of
`fix/issue2870-budget-alignment` (PR #2881) as CI ran it in run `42997642616`, rebased onto
`main` after #2877; this record and its index row landed in the docs-only commit that
followed it. The behavioural checks ran on the macOS build host `macmini` from
`crates/miao-engine`, `cargo 1.99.1`.

## What #2877 settled, and what is left

`2026-11-11-issue2870-billed-budget-wording.md` fixed the wording of the *spent*
note and stated its own limit: "whether a manifest `budget` should measure billing
or context share is a product decision", and "no reminder was added at the
compaction share of the window".

This tree keeps that wording verbatim and does the part it deferred. The issue's
first expectation — "the reminder threshold aligns with the engine's real
compaction threshold; cumulative billed tokens must not pose as a context budget" —
is answered without changing which quantity `budget` measures: the pause now
*prints* the window's own measurement beside the tally, so a reader can see the
two are different.

## What changed

| surface | before | after |
| --- | --- | --- |
| the spent pause (`runtime.rs`) | "160 tokens billed of 100. That is a cumulative billing cap, not the context window — the conversation may still sit well inside the model's window." | the same sentence, then the window's own figures: "…not the context window: the context window carries 130 of 1000000 tokens (0%), against a compaction threshold of 900000 tokens." |
| the wrap-up note at 80% (`history.rs`) | "PROMPT BUDGET WRAP-UP … The token budget for this prompt is nearly exhausted." | "BILLED TOKEN BUDGET WRAP-UP … That figure adds up what the provider charged on every turn of this prompt; it is not how full the context window is, which the engine measures separately and compacts on its own threshold." |
| the runtime's names | `budget`, `budget_spent`, `budget_exhausted`, `budget_wrap_up` | `billed_allowance`, `billed_tokens_spent` (plus `billed_turns`), `billed_allowance_spent`, `billed_allowance_near`, so "budget" in this loop no longer collides with COST-02's `crate::budget` algebra |
| the manifest field (`session_agent.rs`) | "Soft per-prompt token budget, matching the TS agent `budget` setting." | states that it bounds provider-billed tokens per prompt, cannot bound or predict the window, and is a different declaration from the Session budget |
| a drained turn count (`runtime.rs`) | `loop.stopped` reason `"budget"`, text "the provider turn limit (N turns)" | reason `"turns"`, text says it is a count of turns, not a token budget and not a context limit |
| a waiting pause | "N background job(s) still pending (ids)" for jobs *and* running subagents | jobs and delegated subagent tasks are counted and named separately |

The window figures come from `context_trigger::window_note`, which renders the
occupancy the compaction trigger already reads and `Budget::threshold()`
(`window * ratio`, floored by `headroom`) — the same measure as the trigger and
the pressure ladder, so a pause cannot disagree with either about how full the
window is.

## The pins

| pin | command (`crates/miao-engine`) | observed |
| --- | --- | --- |
| the pause carries the billing tally, the turns, and the window against the compaction threshold | `cargo test --test prompt_budget a_billed_allowance_pause_prints_the_window_beside_the_tally` | `ok` — the note holds `160 tokens billed over 4 provider turns against a cap of 100`, `the context window carries`, and `against a compaction threshold of 900000 tokens` |
| a paused drain injects no continuation and leaves nothing admitted | `cargo test --test prompt_budget a_billed_allowance_pause_leaves_no_continuation_behind` | `ok` — the runnable todo list drove the continuation the wrap-up turn answered, then no `loop.continuation` after the pause, `pending_inputs` empty, provider asked no further turn |
| the model's note and the operator's sentence keep #2877's wording | `cargo test --test prompt_budget soft_prompt_budget_wraps_up_then_pauses_with_text_only` | `ok` |
| a fresh prompt re-arms the allowance | `cargo test --test prompt_budget a_new_prompt_grants_a_fresh_budget` | `ok` |
| the goal loop continues and pauses as before | `cargo test --test goal_continuation` | `9 passed; 0 failed` |
| the crate's suites above, whole | `cargo test --test prompt_budget` | `5 passed; 0 failed` |
| format and lints | `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` | clean; `Finished` with no warnings |

The whole-tree record is CI run
[`42997642616`](https://github.com/oxdingzg/miao/actions/runs/42997642616) on that commit;
the docs-only commit after it carries no behavioural change.

## What this record does not claim

- **The threshold semantics are unchanged.** A manifest `budget` still measures
  provider-billed tokens per prompt; this tree makes that fact visible and audible
  rather than choosing a different quantity. Making the *reminder* fire at a share
  of the window would be a behaviour change with its own decision, and the sidebar
  already shows `ctx X / window · Y%`.
- **The subagent half of the waiting pause is #2871's.** `main` suppresses
  continuation injection while background work runs; this tree only stops the
  pause note from calling a running subagent a background job.
- **The window figures need a configured window.** With no copy of the context
  limits the note says the engine has no measured occupancy, which the test pins:
  silence there would read as "the window is not the reason" on evidence no copy
  of the note carries.
- No release stamp: this is a bug fix with the product decision above still open.
