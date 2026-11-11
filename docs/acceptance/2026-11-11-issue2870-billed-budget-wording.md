# Acceptance record — #2870 the pause names the quantity it spent

Issue: #2870 ("budget reminder out of step with real context usage: cumulative billed
tokens vs the model's window, reported as 'budget exhausted'"). Tree: the pull-request head
for branch `fix/issue2870-billed-budget-wording`, parent `origin/main` `eb7da98d91`.
Commands ran on the Linux build host `xx04` from `crates/miao-engine`, `cargo 1.99.1`.

## What the report established

Two different quantities were being read as one:

- the engine's `budget` is the agent manifest's **soft per-prompt token budget**
  (`session_agent.rs:82`), and `budget_spent` adds up `billed_tokens(&reply.usage)` across
  the prompt's turns (`runtime.rs`), so a long orchestration prompt bills tens of millions;
- the sidebar's `ctx X / 1.0m · Y%` is how full the **context window** is.

A run that spent its billing cap therefore reported "budget exhausted", and both the note
the model received and the sentence the operator read said the *prompt token budget* was
spent — which reads as an exhausted context.

## What changed

| surface | before | after |
| --- | --- | --- |
| the note the model receives (`history.rs`'s `BUDGET_EXHAUSTED_PROMPT`) | "CRITICAL - PROMPT TOKEN BUDGET EXHAUSTED … the token budget for this prompt has been exhausted" | "CRITICAL - THE SOFT BILLED-TOKEN BUDGET FOR THIS PROMPT IS SPENT", plus an explicit "this is not a statement about the context window: the conversation may still sit well inside the model's window, so do not tell the operator the context is full or that compaction is due" |
| the sentence the operator reads (`runtime.rs`'s pause note) | "Task paused: the prompt token budget (100 tokens) is exhausted." | "Task paused: this prompt's soft billed-token budget is spent (**160 tokens billed of 100**). That is a cumulative billing cap, not the context window — the conversation may still sit well inside the model's window." |
| the no-budget variant | "the prompt token budget is exhausted" | the same sentence with the billed total and the same distinction |

The spend is now named with its number, so a reader can see that a 160-token spend against a
100-token cap says nothing about a 1M-token window.

## The commands

| pin | command (`crates/miao-engine`) | observed |
| --- | --- | --- |
| the model's note names the billed quantity and disclaims the context | `cargo test --test prompt_budget soft_prompt_budget_wraps_up_then_pauses_with_text_only` | `ok` — the note contains `SOFT BILLED-TOKEN BUDGET` and `not a statement about the context window` |
| the operator's sentence carries both numbers and the distinction | same test | `ok` — `(160 tokens billed of 100)` and `not the context window` |
| a fresh prompt re-arms the budget and drops the note | `cargo test --test prompt_budget a_new_prompt_grants_a_fresh_budget` | `ok` |
| the whole suite | `cargo test --test prompt_budget` | `3 passed; 0 failed` |
| the crate around it | `cargo test --lib` | `477 passed; 0 failed` |
| lints | `cargo clippy --all-targets -- -D warnings` | `Finished` with no warnings from this crate |

The billed total in the assertion is `160` rather than the `120` a reader might expect: the
turn that closes the prompt is itself billed before the pause is recorded. The first draft
of this test asserted the arithmetic instead of the measurement, and the run corrected it.

## What this record does not claim

- **The threshold semantics are unchanged.** Whether a manifest `budget` should mean
  cumulative billing at all, or a share of the context window, or both (the report's first
  expectation), is a product decision that changes behaviour rather than wording. This tree
  makes the existing behaviour honest; it does not change which quantity `budget` measures.
- No reminder was added at the compaction share of the window. The sidebar already shows
  `ctx X / window · Y%`, and the report's "align the reminder with the compaction threshold"
  would be that behaviour change, not this one.

## Version

No `roadmap:` stamp: this tree is in no published release, and this is a bug fix with a
remaining product decision named above.
