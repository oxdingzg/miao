# Acceptance record — COST-04 phase timings and wait reasons

Item: `COST-04`. Tree: this change, based on `main` at `5e3a36d235`. Commands ran
on the Linux build host (`x86_64-unknown-linux-gnu`) from `crates/miao-tui/` at
that tree.

## The three bullets, and where each is accepted

1. **Display elapsed time per phase for each turn.** The TUI keeps a phase
   ledger for the running turn: every frame that moves the run to a new phase
   (waiting → retry → tool → …) closes the phase it left with the time it held,
   and the open phase keeps running against the strip's clock. `/timings` shows
   the closed phases plus the open one marked "so far". Suites: the three new
   app tests below.
2. **Show the reason a turn is currently waiting while it is pending.** Shipped
   earlier on the live strip: the waiting line names the silence and its length,
   and a retry carries the attempt number plus the engine's wait class and the
   provider's own words (`LivePhase::Retrying { attempt, detail, cause }`,
   `crates/miao-tui/src/app.rs`), so a rate limit and a spent balance read
   differently. The timings view repeats the reason per closed retry span.
3. **Collect the phase timings and wait reasons in one reviewable view.**
   `/timings` is that view for one turn — current or, after the run ends, the
   finished turn kept in `last_timings`. Across turns, `/status` already lists
   the newest five turns with their own wall time and time-to-first-token
   (`UsageSummary::turn_timings`), so a slow turn stays visible instead of
   dissolving into an average.

## Suites

| what | command | observed |
| --- | --- | --- |
| the phase ledger closes spans on change and keeps the clock on heartbeats | `cargo test the_timings_view_collects_the_phases_the_turn_left_behind the_timings_view_survives_the_run_ending timings_without_a_turn_say_so_instead_of_opening_an_empty_list` (from `crates/miao-tui/`) | 3 passed; 0 failed |
| the status view keeps its per-turn history | `cargo test each_recent_turn_keeps_its_own_timings` | 1 passed; 0 failed |
| the whole TUI suite on the tree with the change | `cargo test` | all `test result: ok` (21 files), exit 0 |

## What this record does not claim

- The ledger is the client's observation of the run: it starts when the TUI sees
  the first frame, so a phase that ended before attach is not in it. The
  engine-side accounting (VAL-02) remains the billing-grade record.
- Windows unexercised, as before.
