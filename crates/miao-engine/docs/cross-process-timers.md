# Cross-process timer ownership and restoration

Status: design proposal. No code in this change; the implementation follows in
a stacked unit after review of the semantics below.

## Current behavior

Cron schedules and one-shot wakeups run as in-process loops inside the native
engine child. Their rows are durable in the Store, so a restart can see them,
but `recovery()` intentionally never re-fires: it records every pending timer
as `interrupted` with `recovered: true` and stops. This preserves the V2 rule
that post-crash provider continuation requires an explicit design. The cost is
usability: a restart silently drops scheduled work.

## Goal

At-least-once firing of durable timers across child restarts, without silent
provider retries, without a second firing path, and with a seam that a future
multi-process (clustered) deployment can adopt without changing semantics.

## Design

### Ownership moves to the product server

The long-lived product server becomes the timer supervisor. The engine child
stops owning firing loops entirely; it remains the executor that a fired timer
reaches through the existing durable path: the supervisor admits one durable
`session_input` row (the same admission `SessionV2.prompt` performs) and then
sends the advisory `SessionExecution.wake(session)`. A crash between admission
and wake is safe because wake is advisory and the drain re-reads durable inbox
rows.

### Durable fire records make firing idempotent

Firing writes `(timer_id, due_at, admission_id, owner_lease)` into a
`timer_fires` table in the same transaction as the admission. A unique index
on `(timer_id, due_at)` makes a double fire a constraint violation instead of
a duplicate admission. Recovery after a supervisor crash therefore replays at
most once: an existing fire record short-circuits re-admission while still
re-issuing the (idempotent) advisory wake.

Cron definitions remain definition rows; each fire materializes exactly one
one-shot due row (`timer_id` = cron id, `due_at` = that occurrence) plus the
next occurrence, so the unique index covers occurrences rather than crons.

### Leases gate adoption

The supervisor holds a heartbeat lease per `(storage_path, session_id)` with a
monotonic epoch written to the Store. A child that dies stops renewing; a
supervisor may adopt a session's timers only after the lease exceeds twice the
heartbeat interval. Adoption writes a `timer.adopted` resolution replacing
today's `interrupted` record, so history distinguishes "the child was told"
from "the supervisor took over". Timers for live leases are never touched, which
keeps a same-process restart race-free.

Legacy rows written before fire records exist keep today's behavior: recovery
marks them `interrupted` and requires an explicit re-arm. New timers always
have fire records and are adoptable.

### Explicit re-arm stays out of scope

A fired timer that finds a cancelled/failed session is recorded
`skipped:<state>` exactly as today. The supervisor never retries provider work
on its own; a missed fire surfaces as a skipped/skewed record, not as an
automatic continuation. This keeps the crash-continuation rule intact.

### Cluster seam

Everything above is expressed against the lease table and the durable rows;
no behavior depends on both processes sharing memory. A clustered deployment
replaces the local supervisor loop with lease-partitioned supervisors; the
child-facing contract (durable admission + advisory wake) is unchanged.

## Test plan

1. Two real processes: child creates a wakeup and is killed; the supervisor
   process adopts after the lease grace and the session receives exactly one
   admitted prompt.
2. Idempotency: a deliberately duplicated fire attempt hits the unique index
   and does not produce a second inbox row.
3. Adoption grace: a live lease is never adopted; an expired one is, and the
   history records `timer.adopted`.
4. Failure skew: a timer that fires against a cancelled session records
   `skipped:cancelled` and does not retry.
