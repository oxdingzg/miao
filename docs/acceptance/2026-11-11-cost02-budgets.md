# Acceptance record — COST-02 cost, time, and turn budgets stop a run

Item: `COST-02` (#1972). Tree: branch `feat/issue1972`, PR #2861, rebased onto
`main` at `e5d81835b9` (five commits: the budget algebra, the Goal's money axis,
the Session declaration derived from configuration, the run-loop enforcement,
and the integration pins). Commands ran from `crates/miao-engine` on the tree this
PR's CI workflow builds; the observed cells cite that PR's CI run
`42945728445` and the engine shard jobs inside it. Rust is not compiled on the
workstation, so CI is the only evidence this record can cite.

## What changed, in one paragraph

A budget states cost, tokens, provider turns, and wall clock in the units the run
loop observes. It is declared per Session in configuration (`budget`, with the
documented `cost.budget_usd` folded in as the money axis) and per Goal in
`goal.budget` (`iterations`, `tokens`, `wallclock_ms`, and the new `cost_usd`).
Both scopes keep their own accounting window — the Session counts every turn it
ever ran, a Goal counts the turns since the model recorded it — and the run loop
evaluates them at every provider-turn boundary: four fifths spent injects one
visible warning with the remaining amount, a spent limit ends the drain with a
visible fact and a `budget.stopped` event, and every admitted input stays in the
durable inbox for the next run. Enforcement never touches model selection.

## Criterion 1 — "Set cost, time, and turn budgets per Session or Goal and show the remaining amount."

**Command:** `cargo test --test cost_budget`

**Observed:** pending — will cite CI run `42945728445`.

Pinned by these tests in that suite:

- `a_session_cost_budget_stops_the_run_at_the_limit_it_was_given` — a Session
  `cost_usd: 0.5` budget against a provider that charges `0.3` a turn requests
  exactly two turns, then records `budget.stopped` with `axis: "cost"`,
  `scope: "Session"`, `level: "exhausted"`, `remaining.cost_usd: 0`, and
  `spent.cost_usd: 0.6`.
- `a_turn_budget_stops_at_the_stated_turn_count` — `turns: 2` bounds provider
  work to two turns.
- `a_time_budget_stops_a_run_between_turns` — `wallclock_ms: 400` against turns
  that take 250 ms each stops after the second.
- `a_goal_budget_binds_the_work_done_under_it` — with a loose Session budget and
  `goal.budget.tokens: 400`, two 200-token turns stop the run with
  `scope: "Goal"`, so the Goal's own window is what bound it.
- `the_usage_report_carries_the_remaining_amount` — the Session `usage` report
  carries `budget.session` with `level`, `limit`, and `remaining`, so a client
  paints what is left from the report it already reads.

The transcript facts carry the same numbers a reader needs:
`Budget warning: the Session tokens budget is 80% used (800 tokens of 1000
tokens, 200 tokens left)` and `Stopped: the Session cost budget of $0.50 is used
up ($0.60 spent)`.

## Criterion 2 — "Define warning and stop behavior and explain estimation limits when billing lags."

**Command:** `cargo test --test cost_budget a_budget_warns_once_at_four_fifths_with_what_is_left a_cost_budget_discloses_a_turn_whose_charge_was_not_reported`

**Observed:** pending — same CI run.

- `a_budget_warns_once_at_four_fifths_with_what_is_left` — five 200-token turns
  against `tokens: 1000`: the warning appears exactly once, at 800 tokens, and
  names the remainder; the stop note then says the limit is used up. The warning
  is one durable fact (`budget.warning`) rather than a line on every turn.
- `a_cost_budget_discloses_a_turn_whose_charge_was_not_reported` — a turn whose
  provider reported no charge is not read as free: the warning says
  `1 turn(s) carry no price at all, so the money counted here is a lower bound`,
  and the same counters ride `budget.state` as `unpriced_turns` /
  `estimated_turns`. Money counts only what a provider stood behind; a turn
  priced from our rate table is an estimate at list price.
- Unit coverage in `cargo test --lib budget::` pins the same split
  (`one_turn_folds_into_the_observation_and_separates_reported_from_estimated_money`,
  `missing_or_estimated_billing_is_disclosed_where_the_remaining_amount_is_read`)
  plus the thresholds (`a_run_warns_at_four_fifths_and_stops_at_the_limit_on_the_fullest_axis`)
  and the declaration's own shape (`a_declaration_states_at_least_one_positive_bound_and_stays_decidable`).

Warnings fire at four fifths of a stated limit; the stop is taken at a
provider-turn boundary, so an operation already dispatched is never cut in half,
and the note says so: "Close the operation in progress and summarize".

## Criterion 3 — "Preserve admitted input at the budget limit and never auto-upgrade to a paid model."

**Command:** `cargo test --test cost_budget a_budget_stop_leaves_admitted_input_queued a_budget_stop_leaves_the_model_selection_alone`

**Observed:** pending — same CI run.

- `a_budget_stop_leaves_admitted_input_queued` — with `turns: 1`, a queued input
  admitted beside the running prompt is still listed by `pending_inputs` after
  the stop and is absent from the transcript: the stop ends the run, never the
  admission, so raising the budget and sending a message continues the Session.
- `a_budget_stop_leaves_the_model_selection_alone` — the run stops with
  `model_selection` unchanged and no `session.model.selected` event recorded:
  the gate has no route branch, so a budget cannot move a Session onto (or off)
  a paid route.

## Criterion 4 — "Link implementation PR, offline or real client acceptance records, and applicable versions; attach quality, cost, or latency evidence for optimizations."

**Observed:** this record is the offline acceptance evidence; the implementation
PR is #2861 and it references issue #1972. The engine's own `usage` report and
`budget.state` events are the client-facing surface, exercised by
`the_usage_report_carries_the_remaining_amount`; a real-client acceptance pass
for the sidebar row that paints the remainder is not part of this PR and stays
open. COST-02 is a control item, so no quality/cost/latency optimisation is
claimed and none is attached.

## Regression coverage

**Command:** `cargo test --lib`, `cargo test --test state`, `cargo test --test accuracy`, `cargo test --test turn_budget`

**Observed:** pending — same CI run and its engine shards.

- `--test state` re-runs `goal_budget_is_a_structured_boundary_not_prose`, which
  now also refuses a `cost_usd` of zero, a negative figure, and a figure past the
  ceiling, and accepts the money axis beside the existing three.
- `--test accuracy` compares the two committed tool-schema snapshots, which gained
  `goal.budget.cost_usd` and the per-axis ceilings the algebra enforces; the
  snapshots stay reviewed and committed rather than regenerated in CI.
- `--test turn_budget` re-runs the pre-existing provider-turn allowance, whose
  pause path this change reuses and does not alter.
- `config_derive`'s `derived_policy_matches_the_materialized_product_policy`
  pins the new policy field (null when no budget is configured).

## Limits this record states plainly

- Retention removes old `usage` events, so a window that reaches past them
  under-counts. That makes a budget more permissive after retention prunes a
  Session's history; it never makes one silently stricter.
- The wall clock of a scope is measured from its window opening, so idle time
  between runs counts against a Session's time budget.
- A cost budget follows reported and estimated charges as they land; it is not a
  provider-side cap, and a turn already in flight is never interrupted.
