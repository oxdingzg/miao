# ADR-16: Explicit decisions for unknown tool outcomes

Status: Accepted, including the product recovery API and TUI entry point.
Extends ADR-02 without automatic post-crash resume.

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
- A decision defaults to admit-only. A controller can explicitly pass
  `resume: true` to schedule an advisory inbox wake, or separately call `resume`
  or submit a later normal prompt. Advisory wake cannot force another provider
  turn after this instruction has already been promoted, so a repeated recovery
  request cannot repeat provider execution merely because its receipt was lost.
  Execution follows normal promotion, history selection and authorization.
- The original intent, unknown state and reconciled tool result remain
  unchanged. The controller decision and admitted input are additional evidence,
  not a fabricated tool settlement. There is no second execution log or schema
  migration and no automatic re-dispatch of the original call ID.

## Product surface and acceptance

The product exposes `GET /api/session/:sessionID/recovery` and `POST` on the same
path, under the existing authentication and authoritative native placement
middleware. Browser-safe `SessionRecovery` contracts live in Schema, with
generated Promise/Effect SDK methods. Calls use camelCase product fields and
are translated to the engine's wire fields at the native transport boundary.
Missing native ownership, non-unknown calls and conflicting decisions fail;
they never fall through to the TypeScript writer.

The TUI's `/recover` entry lists unresolved calls with paged navigation. Selecting
a call offers retry or abandon, and sends an explicit advisory wake. Operation
identities are retained when the same dialog choice is repeated after a transport
error. The original outcome remains unknown in storage and in the receipt.

`tests/recovery_decisions.rs` covers Host dispatch, admit-only behavior, explicit
advisory wake, one provider continuation, no old-tool replay, exact decision retry
before and after promotion, conflicting decisions, Session isolation and
preserved unknown evidence. Existing Store/runtime recovery tests remain the
interruption-boundary oracle.

`packages/miao/test/engine/native-recovery.test.ts` kills a real engine while a
dispatched question awaits its controller, starts a new native owner on that
database and exercises inspection, admit-only resolution, advisory continuation
and conflicting/exact decision retries. It verifies one original dispatch and
one original question, with no automatic provider request on reopen.
`native-birth-http.test.ts` covers authenticated product inspection and typed
request/refusal behavior. Pending/promoted input recovery does not gain
automatic provider retries from this change.
