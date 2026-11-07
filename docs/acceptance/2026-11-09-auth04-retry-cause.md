# Acceptance record — AUTH-04 retry cause and pause source

Item: `AUTH-04` (retry classification on the provider path; the wait-cause
family). Tree: `41276032ed` plus this branch.

## Problem

A 429 from the vendor and a spent account quota arrive as the same status line:
`retrying (attempt 2) HTTP 429 · {body}`, with no pause source. The TUI could
not say which wait a retry was, so the operator could not choose between
waiting it out and switching account — the exact gap the AUTH family review
named for retries.

## Change

- `provider.rs` derives a retry cause at the failure site — `account_quota`,
  `vendor_rate_limit`, `upstream` (529/overloaded), `auth` (401/403), `bad_request`
  (self-heal), `transport` (everything else) — and a pause source —
  `provider` (the endpoint's Retry-After honored verbatim), `backoff` (the
  runner's capped exponential guess), `immediate` (the one-attempt 400
  self-heal replay). The `provider.retry` progress frame and the durable
  record carry `cause` and `source`; the turn-level replay record carries them
  too (`transport` / `immediate`).
- `miao-tui/src/app.rs` renders the wait class and the pause source on the
  status line: `retrying after 850ms local backoff: account quota (attempt 2) ·
  insufficient_quota — HTTP 429 · {body}`. `2.0s from Retry-After` marks a
  vendor-chosen pause. Reason bodies beyond the classification stay in the
  middle dots.

## Criterion — the status line names the wait class and the pause source

| check | observed |
| --- | --- |
| `cd crates/miao-engine && cargo test --lib provider` | `27 passed; 0 failed` |
| `cd crates/miao-engine && cargo test --test transport_retry` | `5 passed; 0 failed` |
| `cd crates/miao-tui && cargo test --lib retry` | `4 passed; 0 failed` |
| `cargo fmt -- --check`, `cargo clippy --all-targets -- -D warnings` (both crates) | clean on the macOS build host |

`retry_cause` unit tests cover the 429-quota body, the 429 rate-limit body,
529 overloaded, 401, and the transport fallback. The `transport_retry`
integration test asserts the replayed turn's `provider.retry` record still
carries the transport reason. The TUI test drives both frames — an
`account_quota`/`backoff` 429 and a `vendor_rate_limit`/`provider` 429 — and
asserts the status line says `account quota`, `850ms local backoff`,
`insufficient_quota`, and `2.0s from Retry-After`.

## Stays open

- `AUTH-05` (recap of what already waited before a continuation attempt),
  `AUTH-06` (configurable stream idle), `AUTH-07` (durable fail event,
  model-major metadata) — separate PRs on this family.
- The turn's 60 s retry window is a hard cap after the first failure even when
  the endpoint's Retry-After asks for more; changing that is an `AUTH-07`
  decision, not this fix.
