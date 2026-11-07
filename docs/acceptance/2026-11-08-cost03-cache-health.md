# Acceptance record — COST-03 cache health with actionable recommendations

Item: `COST-03`. Tree: `main` including #2687. Commands ran on the Linux build
host (`x86_64-unknown-linux-gnu`) from `crates/miao-tui/` at that tree.

## The criteria this record accepts

**The current Session's cache health is displayed, and each unhealthy state
carries an actionable recommendation.**

- *Displayed*: the sidebar's usage block renders the day's cache health as the
  hit share of billed input — `cache NN%` next to in/out tokens
  (`crates/miao-tui/src/pane.rs`, `UsageSummary::cache_hit`).
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
