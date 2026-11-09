# Acceptance record — COST-03 cache health with actionable recommendations

Item: `COST-03`. Tree: `main` including #2687. Commands ran on the Linux build
host (`x86_64-unknown-linux-gnu`) from `crates/miao-tui/` at that tree.

## The criteria this record accepts

**The current Session's cache health is displayed, and each unhealthy state
carries an actionable recommendation.**

- *Displayed*: the sidebar's usage block renders the day's cache health as the
  hit share of billed input — `cache NN%` next to in/out tokens
  (`crates/miao-tui/src/pane.rs`, `HourlyUsage::cache_hit`), formatted from the
  `cache_hit_ratio` the engine publishes in the hourly totals.
- *Actionable*: #2687 — a hit under half with at least 50 000 billed input
  tokens, the one shape compaction actually fixes, names the fix: the strip
  appends `low cache hit: /compact trims the input later turns resend`. A
  healthy hit stays quiet, and a small session is not worth a recommendation —
  both pinned so the strip never nags.
- *Links*: this record; #2687 is the implementation pull request.

## Suites

| what | command | observed |
| --- | --- | --- |
| unhealthy names `/compact`, healthy and small stay quiet | `cargo test --lib an_unhealthy_cache_hit` (from `crates/miao-tui/`) | `1 passed; 0 failed` |
| the crate around it | `cargo test --lib` | `547 passed; 0 failed` |

## What this record does not claim

- The recommendation names compaction because that is the lever this build
  has; it does not claim every low hit is fixable by it (a route or prompt
  prefix that changes between turns misses for its own reasons).
- Windows unexercised, as before.

## Correction — the share divided by the prompt plus the cache

The first build of #2687 computed `HourlyUsage::cache_hit` as
`cache_read / (input + cache_read)`. Every normalizer reports `inputTokens` as
the whole prompt with the cache axes inside it — `nonCachedInputTokens` is the
remainder (`crates/miao-engine/src/usage.rs`) — so that denominator counted the
cache read twice. Because a cached read can never exceed the prompt it came
from, any Session with `cache_read < input` landed under half: the strip told a
97% hit to run `/compact`, and a day whose figures read `in 284.9m · cache
276.5m` was labelled low.

The definition now lives in one place, `usage::hit_ratio` (`cache_read / input`,
clamped to the prompt), and the session report, the per-turn lineage event, the
hourly totals and `miao usage` all call it. The engine publishes
`cache_hit_ratio` in the hourly `totals`; `crates/miao-tui` only formats that
figure and shows `—` when an engine published none, so the view holds no
arithmetic that can drift from the wire. The same change stops the hourly
`tokens` volume and peak from summing the cache axes on top of an inclusive
prompt.

| what | command | observed |
| --- | --- | --- |
| hourly volume and ratio | `cargo test --lib hours_land_in_the_bucket` (from `crates/miao-engine/`) | `1 passed; 0 failed` |
| usage normalization | `cargo test --test usage` | `5 passed; 0 failed` |
| cache health report | `cargo test --test cache_health` | `1 passed; 0 failed` |
| normalization unit tests | `cargo test --lib usage::tests` | `7 passed; 0 failed` |
| the crate around the strip | `cargo test --lib` (from `crates/miao-tui/`) | `571 passed; 0 failed` |
| the usage command still builds | `cargo check` (from `crates/miao-cli/`) | clean |

Commands ran on the Linux build host (`x86_64-unknown-linux-gnu`) against the
`fix/cache-hit-ratio` tree.
