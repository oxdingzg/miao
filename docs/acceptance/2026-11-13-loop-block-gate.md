# LOOP-01 — a no-progress pause outlives the run that raised it

**Item:** issue #2948 · a paused loop must not restart itself from the next notice
**Tree:** `fix/loop-block-gate` (this record's commit), parent `main` at `b3ce7f27a0`.
**Environment:** Linux x64 build host, `cargo test --test <name>` from `crates/miao-engine`.

## Symptom

One Session — an autonomous goal, runnable todos, 58 background jobs, waiting on
the operator to choose between two paths — emitted **94** text-only "still
waiting" replies and **76** `goal:` continuation inputs in eight hours:

```
engine_input  : goal:<run>:1 … goal:<run>:N   (76 rows)
engine_message: {"text":"待命。","type":"text"} × 94; 184 assistant messages in 1 h
engine_event  : loop.continuation 18, loop.stopped 14 (waiting 10, flat 4) in 3 h
```

`loop.stopped` fired as designed and the loop restarted every time. The cause
was the re-arm rule in `Store::loop_paused_for_operator`: a pause ends at the
next promoted input *other than* `goal:` / `loop-paused-` / `task:`, and a
background notice (`monitor:`/`watch:`/`cron:`/`wakeup:`) is such an input. Every
notice therefore re-opened the same unchanged drain, which paused again only
after another whole round of continuations — a text-only reply per notice,
indefinitely.

## Criterion 1 — "A notice re-opens the loop once, not every time"

**Command:** `cargo test --test goal_continuation a_blocked_loop_survives_a_notification_storm`
**Observed:** `test result: ok. 1 passed; 0 failed`

The first turn pauses (`loop.stopped: flat`, `loop.blocked` round 1). The first
notice is one round of grace — a finished job may be exactly the news the loop
waited for — and the second pause records `loop.blocked` round 2. Every later
notice on the same unchanged list adds **no** `loop.continuation`: the drain is
gated before it can re-prompt. The Session ends with `goal.status = "blocked"`
and `loop: ` evidence.

A changed todo list needs no event at all: it carries a different signature, so
the next drain continues (criterion 3 of the same suite,
`continues_independent_work_without_a_human_prompt_then_idles_with_locked_dependents`).

## Criterion 2 — "A block is a gate, not an off switch"

**Command:** `cargo test --test goal_continuation an_operator_message_re_arms_a_blocked_loop`
**Observed:** `test result: ok. 1 passed; 0 failed`

An operator input admitted after the block records `loop.armed`, restores
`goal.status` to `active` from the `loop: ` evidence the engine wrote, and the
drain continues (`loop.continuation` grows again). Resuming needs no command and
loses nothing: the todo list and the goal stay durable across the block.

## Criterion 3 — "The operator's own off switch is unchanged"

**Command:** `cargo test --test goal_continuation an_operator_pause_is_not_re_armed_by_a_notification`
**Observed:** `test result: ok. 1 passed; 0 failed`

A goal recorded as `paused` yields no `loop.continuation` and no `loop.armed`
even when a notice arrives, and its status stays `paused`. The engine only
clears a block whose evidence it wrote itself (`loop: ` prefix).

## Regression sweep

`cargo test --test goal_continuation` — `test result: ok. 12 passed; 0 failed`,
including the pre-existing `no_progress_is_bounded_and_synthetic_admissions_do_not_restart_the_loop_budget`,
`stalled_todos_pause_the_loop_without_any_goal`,
`only_waits_paused_goals_and_missing_authorization_never_create_extra_turns`,
`a_churning_todo_list_is_bounded_instead_of_running_forever` and
`unlimited_product_tasks_keep_continuing_past_twenty_five_goal_iterations`.

The adjacent suites (`--lib`, `empty_completion`, `supervision`, `verification`,
`state`, `children`) are recorded in the pull request.
