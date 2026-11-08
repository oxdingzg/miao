# RUN-01 — input receipts, steer/queue, and exact retry

**Item:** RUN-01 · sessions, delivery and crash recovery
**Tree:** `feat/run01-input-receipts` (this record's commit), parent `origin/main` after #2698.
**Environment:** Linux x64 build host, `cargo test --test <name>` from `crates/miao-engine`.

## Criterion 1 — "Distinguishes sent, admitted, pending-promotion, executing and failed, and marks steer/queue"

**Command:** `cargo test --test run01_input_receipts a_receipt_walks_the_lifecycle`
**Observed:** `test result: ok. 1 passed; 0 failed`

The receipt surface (`Store::input_status`) reports `state` of `pending`
(admitted, not yet visible — with `delivery` and `pending_ahead`, the position
inside its own delivery class), `promoted` (with the transcript `seq`,
`recorded_at_ms` and `checkpoint` of the visible user message), `cancelled`,
and — added by this PR — the consuming run: the latest `run.started` after the
promotion, whose `engine_run` state *is* the finish reason, surfaced as
`run.state` of `executing` (still running) / `failed` / `completed` /
`interrupted`. A later run supersedes an older one's picture (continuation and
retry open newer runs). "Sent" is the client-side step before the durable
receipt exists and is out of the engine's ledger by design.

## Criterion 2 — "A server-side retry of a durable identity creates neither a duplicate message nor a duplicate call"

**Command:** `cargo test --test run01_input_receipts an_exact_retry_of_a_durable_identity`
**Observed:** `test result: ok. 1 passed; 0 failed`

Re-admitting the same `input_id` returns `duplicate: true` with the original
`admitted_seq`; conflicting reuse (different prompt, delivery, session,
attachments, command or agent references) is refused with `Conflict`; a
cancelled identity stays dead. Promotion happens once — the run counts exactly
one `input.promoted` event for the admission, and the visible message lands at
`admitted_seq + 1`.

## Criterion 3 — "Queued messages are promoted only at a safe boundary, and order is restored after reconnection"

**Command:** `cargo test --test run01_input_receipts queued_inputs_promote_one_per_idle_boundary`
**Observed:** `test result: ok. 1 passed; 0 failed`

`promote(session, idle=false)` promotes the pending steers only; the queued
inputs stay pending. `promote(session, idle=true)` promotes exactly one queued
input, oldest first. After dropping the store handle and reopening the storage
from the same path (the reconnect), a fresh handle reads the same receipts and
the promoted message seqs follow admission order.

## Regression coverage

**Command:** `cargo test --test input_status --test input_cancel_cycle --test input_edit --test interrupt_sends_queued --test retry_attribution`
**Observed:** `2 passed`, `4 passed`, `4 passed`, `1 passed`, `2 passed` — `0 failed` across all five.
