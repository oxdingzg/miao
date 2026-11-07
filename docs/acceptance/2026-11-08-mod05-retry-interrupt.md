# Acceptance record — MOD-05 retry visibility and cancelling a retrying run

Item: `MOD-05`. Tree: this change, based on `main` at `c13275e9a6` (`#2676`).
Commands ran on the Linux build host (`x86_64-unknown-linux-gnu`) from
`crates/miao-engine/` and `crates/miao-tui/` at that tree.

## The two criteria this record accepts

**A retry shows its attempt count, its reason and when the next attempt is due.**
The durable `provider.retry` fact carries the whole set — `attempt`, `reason`,
`status`, `cause`, `source`, `delay_ms` — journalled by the runtime when the
retry is announced (`crates/miao-engine/src/runtime.rs`), and the status strip
reads it out: the attempt number, the engine's wait class, the pause source and
the provider's own words, kept across heartbeats. Lineage: the projection's
retry variant with the engine-computed next time shipped in #1759; the wait
class and pause source vocabulary in #2647; the account/model switch offered on
quota retries in #2651.

**The operator can cancel a run that is retrying without waiting for the next
attempt.** The pause before a retry races the run's cancellation token inside
the engine (`announce_retry` selects between the cancel signal and the sleep),
and this change adds the regression the item called for: a turn sitting in a
retry pause answers `cancel` immediately — the run finishes `interrupted` and
the provider never sees the attempt the pause was counting down to.

## Suites

| what | command | observed |
| --- | --- | --- |
| cancelling inside a retry pause | `cargo test --test transport_retry an_interrupt_lands` (from `crates/miao-engine/`) | 1 passed; 0 failed, 5 consecutive runs (0.36–0.42 s each) |
| the transport-retry suite around it | `cargo test --test transport_retry` | `6 passed; 0 failed` |
| the strip names attempt, reason, wait class and pause source | `cargo test retry` (from `crates/miao-tui/`) | `an_announced_retry_is_visible_while_it_waits`, `a_retry_names_the_wait_class_and_the_pause_source`, `a_retry_shows_the_providers_own_reason`, `a_transport_retry_does_not_advertise_switching` — `5 passed; 0 failed` |

## What this record does not claim

- Cost attribution for all-failure paths stays with VAL-02's billing-grade
  engine accounting, as the item's earlier notes say.
- The other criteria in this item's checklist are accepted by the records this
  one links: the rate-limit naming and self-healing vocabulary by
  `2026-11-09-auth04-retry-cause.md` (#2647) and the fallback naming by the
  config/extension record `2026-11-04-config-ext-retry.md` (#2483).
- Windows unexercised, as before.
