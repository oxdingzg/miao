# Acceptance record — a `Retry-After` beyond the retry window

Item: `#2862` problem one. Tree: branch `fix/retry-after-grace` on
`origin/main` `8207739c8b`; the pull request's squash commit lands the same
content. The commands below were run from `crates/miao-engine` and
`crates/miao-tui` on `xx04` (Linux, 20 cores) against this tree.

The defect: the turn kept one fixed 60 s retry window, and the loop refused any
pause longer than what was left of it. A gateway that answered
`429 · retry-after: 30s` therefore earned exactly one attempt — the second 30 s
pause arrived against a window with 30 s left and ended the turn, even though
the endpoint had done nothing wrong and had said when it would be ready. That is
the shape reported in `#2862` and visible in the recorded `stop_failure` rows.

## Criterion — "Honour a pause the endpoint named instead of ending the turn."

A pause the endpoint itself named is now paid **outside** the window: the window
stays this runner's own guess about how long to keep failing, while a
`Retry-After` is the provider's statement about when it will answer. The
window's remaining time is preserved across the wait, and the allowance is
bounded twice — `VENDOR_WAITS_PER_TURN = 2` and `VENDOR_WAIT_TOTAL = 90 s` — so
a wrong or hostile header cannot hold a turn for most of an hour. A backoff this
runner chose stays inside the window, exactly as before.

| command | observed |
| --- | --- |
| `cargo test` (miao-engine, full suite) | ok — every target `test result: ok`, 0 failed |
| `cargo test` (miao-tui, full suite) | ok — every target `test result: ok`, 0 failed |
| `cargo test --lib provider::` | ok. 23 passed; 0 failed |
| `cargo test --test transport_retry` | ok. 7 passed; 0 failed |
| `cargo test --lib app::` | ok. 191 passed; 0 failed |
| `cargo clippy --all-targets -- -D warnings` (both crates) | exit 0 |

Pinned by `crates/miao-engine/src/provider.rs`:

- `a_vendor_pause_beyond_the_window_is_paid_outside_it` — a 300 ms window, a
  `429 · retry-after: 1`, then a 200: the turn retries and succeeds; the retry
  frame carries `delay_ms 1000` and `extended_ms 1000`, which is what marks the
  wait as the endpoint's schedule rather than a longer local guess.
- `the_vendor_wait_allowance_ends_and_names_itself` — an endpoint that keeps
  answering `429 · retry-after: 1` earns two granted waits and then stops: three
  requests, two `1000 ms` delays, one `provider.window` refusal whose note says
  `already extended its retry window 2 times`, and the failure text carries the
  same sentence.
- `a_backoff_beyond_the_window_still_refuses` — a 500 with no `Retry-After`
  under a 100 ms window refuses at once, without sleeping, and its note keeps
  the backoff wording (`the next backoff was …`).

Pinned by `crates/miao-tui/src/app.rs`:

- `a_named_pause_counts_down_while_the_retry_waits` — the strip reads
  `Retrying · attempt 2 · 30.0s left · …` and, twelve seconds later,
  `18.0s left`: the wait is visibly moving instead of being re-read from a
  static number.
- `an_extended_wait_names_the_extension` — a frame with `extended_ms` adds
  `window extended`, so a wait longer than the runner's own window is not read
  as a budget the runner lost control of.
- `a_refused_retry_says_why_no_attempt_followed` — the refusal still lands on
  the strip (from the earlier visibility change), now beside the allowance
  wording.

## Deliberately open

- A `Retry-After` longer than the 90 s allowance still ends the turn; that is
  what the allowance is for. The refusal names the pause and the extra wait that
  was left, so the operator can see it was the endpoint asking for more time
  than this turn would spend.
- An already expired window keeps its own short-circuit message
  (`the turn's retry window was spent before another request (last attempt: …)`)
  rather than the refusal note; the two remain distinct facts.
- The countdown is anchored where its frame arrives, so a replayed durable retry
  starts counting from the replay rather than from the original pause.
- Telling a parent when a child Session failed (`#2862` problems two and three)
  is untouched here: this record covers the retry policy only.
