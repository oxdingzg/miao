# Acceptance record — a continuation loop that never moves the todo list

Item: the repeated-continuation loop reported against the goal loop (a Session
kept receiving the fixed `Continue the next dependency-ready todo…` prompt and
answering `等待中`). Tree: branch `fix/continuation-flat-cap` on `origin/main`
`bc9d8bc399`; the pull request's squash commit lands the same content. Commands
were run from `crates/miao-engine` on `xx02` (Linux, 20 cores).

Two paths defeated the existing guard:

1. The stall signature was the todo list's whole JSON, so a turn that rewrote a
   todo's words — or re-sent the same list in another shape — counted as
   progress and cleared `goal_stalls` (`runtime.rs`).
2. A turn that dispatched tools only fed the backoff (`goal_polls`), never the
   stall count, on the argument that long tasks legitimately run many turns
   without touching the list.

Either path alone left the loop able to re-prompt itself indefinitely, which is
what the recorded transcripts show: the same continuation sentence, round after
round, with the list unchanged in meaning.

## Criterion — "A loop that does not move the todo list stops and asks."

- `state::todo_signature` reduces the list to `id:status` pairs, so prose,
  priority, dependency decoration and re-sorting are not progress.
- `MAX_FLAT_CONTINUATIONS = 24`: consecutive continuation turns whose signature
  did not move — with or without tools — end the loop with
  `loop.stopped { reason: "flat" }` and a pause message that says the loop
  stopped repeating itself and what the operator can do.
- The pause is durable: `store::loop_paused_for_operator` keeps the loop from
  resuming until an operator-caused input arrives, so the pause's own injected
  message cannot restart the loop with fresh counters.
- Any continuation this run already admitted is cancelled when the loop pauses,
  so nothing is left queued to start the next drain on its own.
- The faster text-only stop (two unchanged turns plus the wall-clock floor) is
  unchanged.

| command | observed |
| --- | --- |
| `cargo test --test goal_continuation` | ok. 9 passed; 0 failed |
| `cargo test --lib runtime::` | ok. 30 passed; 0 failed |
| `cargo clippy --all-targets -- -D warnings` | exit 0 |

The full suite is not re-run here: `ci.yml` shards it across four runners for
every pull request, and re-running it on a shared build host only delays the
answer this record needs (the three commands above cover the changed surface).

Pinned by `crates/miao-engine/tests/goal_continuation.rs`:

- `a_churning_todo_list_is_bounded_instead_of_running_forever` — a provider that
  rewrites the same todo's words forever now stops after the cap: 50 provider
  turns (one initial pair plus 24 pairs, two turns per continuation), one
  `loop.stopped { reason: "flat" }`, the pause text, and the list still holds
  the unfinished work the operator has to decide about.
- `changing_progress_does_not_refill_the_provider_allowance` — kept its original
  intent (an engine continuation does not refill the provider allowance) with the
  turn budget lowered to 5, below the flat cap, so it still measures the
  allowance rather than the cap.

## Contract change

`unlimited_product_tasks_keep_continuing_past_twenty_five_goal_iterations`
asserted that a churning list continues without any `loop.stopped`. That is the
behaviour this record removes: a list whose meaning never moves is no longer
unbounded, whatever its prose says. The test is now
`a_churning_todo_list_is_bounded_instead_of_running_forever`.

## Deliberately open

- The cap counts continuation turns, not wall clock; a genuinely long task that
  never changes a todo's state is bounded at 24 continuations and needs the
  operator to speak. Changing that number is a policy knob, not a code change.
- Tools that produce no todo-state change still count as flat, by design: the
  loop cannot tell a productive tool batch from a repeated status read, and the
  cap is what makes the difference safe to ignore.
