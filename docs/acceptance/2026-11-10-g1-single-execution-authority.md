# Acceptance record — G1: single execution authority

Item: REL-04 gate G1 (`specs/rust-retirement-gates.md`). Tree: `2e9b0a17e5`
(origin/main incl. #2826). Verification ran 2026-11-10 on the macOS build host
(`stable-aarch64-apple-darwin`, debug profile) against this tree's `miao-engine`.

## 1. Composition root — one durable owner per Session

The product process binds the Session's storage, admission, and event stream in
one place, `crates/miao-cli/src/cli.rs` (the headless run path; the TUI binds
the same engine through `crates/miao-tui`):

- `client.initialize(&session, "run")` (`cli.rs:4900`) admits the durable
  Session; `.subscribe(&session, 0)` (`cli.rs:4902`) registers the event
  replay cursor. Every provider turn the process settles is recorded through
  that one store connection.
- A process holds **one store per path**: re-opening the same database answers
  "runtime already owns this store" instead of handing out a second writer
  (`cli.rs`, the `--continue` resolution comment and behaviour).
- All write paths funnel through `Store` transactions with lease fencing:
  `start_run_fenced` / `start_run_with_inputs_fenced` call `require_lease`
  before any promotion or run row (`store.rs:2483`, `store.rs:2496`,
  `store.rs:2513`), so a superseded writer cannot open a run even with the
  database file in hand.

## 2. One running execution per Session — enforced by the database

`store.rs:391` creates the partial unique index
`engine_active_run ON engine_run(session_id) WHERE state='running'`. A second
`start_run` on a Session with a live run cannot commit — SQLite rejects the
insert, not a higher layer's good intentions.

New tests pinned this round (`crates/miao-engine/tests/single_active_run.rs`,
written for this record):

- `a_second_run_on_a_live_session_is_rejected_until_the_first_finishes` —
  start → second start rejected → first still owns the Session → after
  `finish_run` the next run is accepted.
- `different_sessions_run_concurrently` — cross-Session concurrency stands
  while same-Session serialism is enforced.

Results on this tree: `single_active_run` **2 passed / 0 failed**.

## 3. Durable ownership across restarts

`crates/miao-engine/tests/concurrent_open.rs` (existing, re-run this round,
**3 passed / 0 failed**) proves the lease lifecycle: a startup recovery skips
Sessions with a live lease (`startup_recovery_skips_sessions_with_a_live_lease`),
adopts them once the lease expires, and a second runtime sharing the store
file must not die with SQLite `Busy`.

## 4. Placement migration and rejection

`crates/miao-engine/tests/migration.rs` (existing, re-run this round,
**5 passed / 0 failed**) covers the historical placements' migration and
rejection paths on the current store: staged→cutover freezes and reopens the
Session, abort stays pre-cutover-only with exported sources fenced, pending
inputs are refused at migration time and retry identity is upgraded,
a downgraded store version finishes the migration idempotently on reopen, and
shutdown joins the heartbeat before releasing the last store handle.

## 5. Session store module suite

`cargo test --lib store` (filtered to the store module): **20 passed / 0
failed**, including the usage rollups and the fenced-input promotion tests.

## What this record does not claim

The TS-side retirement (deleting `packages/core/src/session/runner/` and its
two production edges) is gate criterion 3 — blocked on nothing any more (the
observation window is closed by owner decision) but executed as RUS-02 steps
2–3 in their own PRs, each re-running the static import inventory. Client-facing
semantics (delivery, approval, error recovery per client) are G3's separate
record.
