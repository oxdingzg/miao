# ADR-16: Explicit decisions for unknown tool outcomes

Status: Accepted for the controller protocol. Product UI integration remains a
separate acceptance item. Extends ADR-02 without automatic post-crash resume.

## Problem

Recovery already closes interrupted runs, settles never-dispatched tools as
not-executed, and preserves dispatched-but-unsettled calls as unknown. Prompts
remain durable, but a controller needs a structured, idempotent way to inspect
that uncertainty and request another attempt or abandon the operation.

## Decision

- `recoveries` lists unknown calls in one Session, with their original call/run
  identifiers, tool name and any prior controller decision. It pages by call ID
  and returns at most 100 rows; arguments and credential-bearing inputs are not
  returned by this listing.
- `resolve_recovery` is a controller command, never a model tool. It binds
  `operation_id`, `call_id`, Session and `retry|abandon` in one durable event.
  The Session must be idle and belong to this Runtime's Location. A matching
  decision retry returns the original receipt even after its input is promoted;
  a changed operation or decision for the same call conflicts. Operation IDs
  also serve as globally unique input identities through normal admission.
- The same transaction admits exactly one steer instruction named
  `recovery_<operation_id>`. Retry instructs the runner to inspect current state
  and issue a new, permission-checked tool call only if still needed. Abandon
  instructs it not to retry this operation. Neither decision claims the old
  effect was undone, committed or completed.
- A decision does **not** schedule execution. The controller separately calls
  `resume` or submits a later normal prompt; provider execution still follows
  normal inbox promotion, history selection and per-call authorization.
- The original intent, unknown state and reconciled tool result remain
  unchanged. The controller decision and admitted input are additional evidence,
  not a fabricated tool settlement. There is no second execution log or schema
  migration and no automatic re-dispatch of the original call ID.

## Acceptance and remaining integration

`tests/recovery_decisions.rs` covers Host dispatch, admit-only behavior, explicit
resume, one provider continuation, no old-tool replay, exact decision retry
before and after promotion, conflicting decisions, Session isolation and
preserved unknown evidence. Existing Store/runtime recovery tests remain the
interruption-boundary oracle.

This protocol closes the structured controller decision mechanism. A full
product recovery view, product-handler routing and actual attached-client
restart acceptance must still be implemented and verified. Pending/promoted
input recovery does not gain automatic provider retries from this change.
