# Acceptance record — COST-04 phase timings and wait reasons

Item: `COST-04`. Tree: `18b3a92cc3` (current `main`; the `docs/cost04-turn-timings`
branch adds only this record and its README row on top of it). Commands ran on the
Linux build host (`x86_64-unknown-linux-gnu`) from `crates/miao-tui/` at the branch
head, which is that tree plus the documentation.

One correction to the trail this record follows: the issue's basis cites
`cargo test --lib turn_timings`. On this tree that filter matches no test:
`test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 555 filtered out`.
The phase-ledger work renamed the suites — `2026-11-08-cost04-turn-timings.md`
already cites the current names — so this record runs those names, one command per
acceptance bullet.

## Criterion 1 — "Display elapsed time per phase for each turn."

| criterion | command | observed |
| --- | --- | --- |
| every frame that moves the run to a new phase closes the span it left, the open phase keeps running against the strip's clock (heartbeats do not restart it), and the finished turn is kept after the run ends | `cargo test --lib -- the_timings_view timings_without_a_turn a_heartbeat_does_not_restart_the_elapsed_time` | `test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 551 filtered out` (`the_timings_view_collects_the_phases_the_turn_left_behind`, `the_timings_view_survives_the_run_ending`, `timings_without_a_turn_say_so_instead_of_opening_an_empty_list`, `a_heartbeat_does_not_restart_the_elapsed_time`) |

## Criterion 2 — "Show the reason a turn is currently waiting while it is pending."

| criterion | command | observed |
| --- | --- | --- |
| the waiting line names the silence and its length (`Waiting for model · no engine signal 20.0s`), a retry carries the attempt number with the engine's wait class or the provider's own words, and a stalled engine is called out without claiming failure | `cargo test --lib -- a_waiting_run_counts_the_wait an_announced_retry_is_visible a_retry_shows_the_providers_own_reason a_retry_names_the_wait_class a_silent_engine_is_called_out` | `test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 550 filtered out` |

## Criterion 3 — "Collect the phase timings and wait reasons in one reviewable view."

| criterion | command | observed |
| --- | --- | --- |
| `/timings` lists one turn's spans with the wait reason in the retry row labels (`retry {attempt} · {why}` from `phase_label`), for the current turn or the last finished one; `/status` keeps the newest five turns with their own wall time and time-to-first-token | `cargo test --lib -- the_timings_view timings_without_a_turn each_recent_turn_keeps_its_own_timings` | `test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 551 filtered out` (`each_recent_turn_keeps_its_own_timings` runs from `status::tests`) |

## What this record does not claim

- The ledger is the client's observation of the run: it starts when the TUI sees the
  first frame, so a phase that ended before attach is not in it. Engine-side
  accounting remains the VAL-02 record.
- Windows unexercised, as before.

Result: all three COST-04 bullets have passing runs on `18b3a92cc3`; nothing inside
the bullets stays open.
