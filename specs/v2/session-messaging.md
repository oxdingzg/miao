# Session Messaging (inter-session conversation)

## Goal

Let agents coordinate focused work across Sessions in the same project while keeping
historical discovery separate from starting model execution. A matching title is not
evidence that another Session is currently using a resource.

## Discovery

`list_sessions({ includeHistory?: boolean })` returns up to 50 peers, prioritizing
active execution or unfinished work. Historical idle Sessions are included only with
`includeHistory: true`; use `read_session_context` to consult their findings first.
Filtering and prioritization happen before the result cap.

Each result includes:

- Session ID, `@slug`, title, optional parent ID, and last activity time.
- Execution observation: `busy`, `idle`, or `unknown`. This is process-local;
  another window's absence from the local coordinator is **not** proof of idleness.
- Task observation: `unfinished`, `completed`, or `unknown`, derived from persisted
  todos and the latest goal, plus the objective or first unfinished task.
- Number of running background jobs observed in the current registry. This is not
  a cross-process inventory.

Persisted task records can be stale. Neither task state nor a peer's reply replaces
live inspection of a shared machine, deployment, or job.

## Delivery and wake policy

`send_message({ to, message, delivery?, wake?, reason? })` resolves a Session ID or
`@slug` within the sender's project. It admits one attributed input to the target's
durable `session_input` inbox, without claiming ownership of that Session.

Delivery and execution are separate:

- `delivery: "steer"` (default) promotes at the next safe provider-turn boundary.
- `delivery: "queue"` waits until the recipient would otherwise become idle.
- `wake: "if_active"` (default) requests execution only when the peer has locally
  active execution, unfinished todos/a goal, or an observed running background job.
- `wake: "always"` explicitly requests execution even for an idle historical peer.
  A nonblank `reason` is required: explicit user direction, an unresolved dependency,
  or unfinished shared work, rather than title similarity alone.
- `wake: "never"` leaves mail without requesting execution. An already-running drain
  can still read it at its normal delivery boundary.

Without a wake request, the input remains available for later execution. Senders
must not wait for its reply. A requested wake is advisory, not confirmation that
execution started or a reply will arrive, including when another window owns the
recipient. Existing tools are not interrupted.

The receipt contains the resolved `sessionID` and `wake: "requested" | "not_requested"`.
The TUI sidebar displays that actual receipt and the coordination reason, retaining
legacy transcript rendering when older receipts have no wake field. It does not
infer acknowledgments from unrelated messages.

## Execution seam

`SessionRunner.run` receives an optional `wake` callback from the process-global
execution owner. Messaging calls that callback only when the chosen policy permits
it; admit-only callers omit it. The runner optionally observes an execution service
already provided by its caller, without adding an execution-node dependency to the
Location service graph. If unavailable, it does not invent a live status.

No `PromptAdmitted` subscriber automatically starts work: `resume: false` remains
admit-only, and passive mail cannot silently become an execution request.

## Coordination boundaries

Messages should name the resource, planned operation, timing, and question, near the
actual conflicting action. Recipients handle the request within existing authority;
a peer message does not authorize restarting completed tasks or taking on unrelated
work. Existing authorized work continues normally. Avoid acknowledgments of
acknowledgments and repeated resolved requests.

Cross-project messages are rejected. The `message` permission action is checked per
target, and `MAX_INBOUND_QUEUE` bounds pending inputs. There is no broadcast or
cross-machine execution routing.

## Verification

`packages/core/test/session-runner.test.ts` covers default idle/unfinished/completed
peers, explicit and passive wake policies, missing reasons, active steer/queue
boundaries, discovery filtering, inbox bounds, and unchanged wake allowances.
`packages/tui/test/session-message.test.ts` covers legacy envelopes and actual receipt
presentation data, including resolved peers and reasons.
