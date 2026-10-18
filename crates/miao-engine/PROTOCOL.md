# miao-engine stdio protocol (v0, frozen M0)

The engine is a headless, protocol-first runtime. This document freezes the
surface that an external shell (TUI, editor, CLI, ACP bridge) implements
against, and the lifecycle event vocabulary it observes. Both are additive:
new optional params, new event variants and new payload fields are compatible;
renaming or removing an existing name or reserved field is a protocol break.

The wire revision is `engine-stdio-0`, read from `miao-engine --version` and
exported as `miao_engine::events::PROTOCOL_VERSION`. A client refuses a
revision it does not know.

## Transport

One JSON object per line on stdin/stdout. A request carries a string or number
`id`; the response carries the same `id` and either `result` or `error`.
Notifications carry no request id. Only local stdio is defined here; the engine
does not claim ACP or the existing miao HttpApi is compatible.

## Methods

| Method | Params | Result |
| --- | --- | --- |
| `subscribe` | `session_id`, `after` | `{accepted:true}` |
| `unsubscribe` | `session_id` | `{accepted:true}` |
| `admit` | `input`, `resume`, `attachments?` | `Admission` |
| `resume` | `session_id` | `{accepted:true}` |
| `cancel_input` | `session_id`, `input_id` | `{accepted:bool, reason?}` |
| `cancel` | `session_id` | `{accepted:bool}` |
| `archive` | `session_id`, `archived` | `{accepted:true, archived}` |
| `remove` | `session_id` | `{accepted:bool, reason?}` |
| `request_compact` | `session_id` | `{accepted:true, duplicate, pending}` |
| `events` | `session_id`, `after` | `Event[]` (page ≤ 100) |
| `snapshot` | `session_id` | committed Session snapshot |
| `sessions` | — | `string[]` (Session ids) |
| `fork` | `session_id`, `target_session_id`, `message_seq?` | `{target_session_id}` |
| `revert` | `session_id`, `checkpoint` | `{checkpoint, from_seq, reverted}` |
| `unrevert` | `session_id` | `{restored}` |
| `approve` | `session_id`, `response` | `{accepted:true}` |
| `history` | `session_id`, `selected` | `Message[]` |
| `context` | `session_id`, `epoch?` | Context Epoch or null |
| `compact` | `session_id`, `compaction_id`, `through_message_seq`, `summary` | checkpoint |
| `recall` | `session_id`, `query`, `limit?`, `before_message_seq?` | bounded matches |
| `questions` / `answer_question` | `session_id`, … | pending / accepted |
| `state` / `update_state` | `session_id`, … | Session state |
| `jobs` / `job` / `cancel_job` | `session_id`, … | background jobs |
| `crons` / `cancel_cron` | `session_id`, … | schedule |
| `wakeups` / `cancel_wakeup` | `session_id`, … | schedule |
| `shutdown` | — | terminates the process |

`event` notifications are committed canonical events; `progress` notifications
are ephemeral provider frames that are not durable and may be followed by a
`resync`. A slow stdout consumer is terminated and reconnects by reading
committed events, so replay→live never depends on a transient frame.

## Lifecycle event vocabulary

The ~13 core events below are the frozen M0 surface. They are recorded as
canonical events in the durable ledger, emitted verbatim as stdio `event`
notifications, and reproduced by `export`. `subagent_*` are reserved until the
engine grows a subagent capability; they are never emitted today but stay in
the vocabulary so a future producer does not rename the surface.

| Event | Reserved payload fields |
| --- | --- |
| `session_start` | `run_id` |
| `user_prompt_submit` | `run_id`, `input_id` |
| `pre_tool_use` | `run_id`, `call_id`, `tool` |
| `post_tool_use` | `run_id`, `call_id`, `tool` |
| `permission_request` | `run_id`, `call_id`, `tool`, `resource` |
| `permission_denied` | `run_id`, `call_id`, `tool`, `resource`, `reason` |
| `subagent_start` | `run_id`, `subagent_id` |
| `subagent_stop` | `run_id`, `subagent_id` |
| `pre_compact` | `compaction_id`, `through_message_seq` |
| `post_compact` | `compaction_id`, `through_message_seq` |
| `stop` | `run_id`, `reason` |
| `stop_failure` | `run_id`, `reason` |
| `instructions_loaded` | `run_id`, `sources` |

Host-configured hooks select by the same names. Tool-scoped events
(`pre_tool_use`, `post_tool_use`) match a hook by tool name; every other event
only matches the `*` hook. A failing `pre_tool_use` hook blocks dispatch; a
failing `post_tool_use` hook is observed but never changes the result.

## JSONL export

`miao-engine export --db PATH --session ID [--after CURSOR]` streams the same
committed events as JSONL from a read-only high-water snapshot, with no provider
credential and without owning execution. It is the second half of the headless
acceptance: the stdio form and the exported form must describe the same ledger.

## HTTP transport (`engine-http-0`)

A loopback HTTP mapping of the same method table, for clients that cannot use
stdio. `POST /rpc` takes one JSON request object — the same `{id, method,
params}` shape as a stdio line — and returns the same `{id, result|error}`
envelope; `GET /version` reports the revision. Every response carries
`miao-engine-protocol: engine-http-0`, and a request may send that header to pin
the revision (a different value is rejected with `unsupported_protocol`). The
engine requires `Authorization: Bearer <token>`: the token is supplied at startup
and an unauthenticated or wrong-token request is rejected before the runtime is
touched. The engine binds a loopback listener only; TLS and public exposure are a
local proxy's job.

## ACP transport (`acp`)

`miao-engine acp ...` speaks the Agent Client Protocol to an editor over
newline-delimited JSON-RPC 2.0 on stdio, reusing the same domain model and the
startup workspace. This slice implements `initialize`, `authenticate`,
`session/new`, `session/prompt` (a text turn streamed as `session/update`
`agent_message_chunk` notifications), the `session/cancel` notification, and the
`session/request_permission` round-trip: each engine approval is sent to the
client as a permission request (allow-once / reject-once) and its answer resolves
the approval. Committed tool calls stream as `tool_call` (pending) and
`tool_call_update` (in-progress/completed/failed) notifications. `session/load`
replays the committed conversation as `user_message_chunk`/`agent_message_chunk`
chunks, `session/fork` returns a fresh Session id, and `session/resume` /
`session/close` are acknowledged. `session/set_mode` switches the collaboration
mode and echoes `current_mode_update`, and committed todos stream as `plan`
entries. `session/list` returns the Sessions in the engine database. Config/usage
updates are later slices.

`GET /events?session_id=..&after=..` streams Server-Sent Events: the committed
`event` notifications for that Session (each frame carries `id: <seq>`, and a
reconnecting `EventSource` may resend `Last-Event-ID` instead of `after`), then
live committed events and ephemeral `progress` frames. The durable `seq` cursor
is authoritative, so replay→live has no gap or duplicate and a lagged progress
subscriber only receives a `resync` frame; a slow client can never block the
provider or the run loop.

### Question rejection

`reject_question` takes `session_id` and `rejection` (`question_id`, `input_hash`).
It durably resolves only the corresponding pending question as `rejected` and
lets the tool/result loop continue. It never cancels the Session. The engine
checks the original input binding, location, active run and expiry in the same
transaction. An exact rejection retry preserves the cursor; cross-session,
changed-hash and already-answered requests fail.

### Guarded interruption

`cancel_if` takes `session_id` and `run_id`. The Session actor checks its active
run and cancels that owner's token as one serialized command. It returns
`accepted: false` for a missing, idle, already-cancelled or changed run. A stale
run ID cannot cancel the next run; a failed match also preserves pending wakes.

### Pending-input cancellation

`cancel_input` takes `session_id` and `input_id` and drops one admitted input
that has not been promoted yet. The admission row is retained as `cancelled`
evidence and an `input.cancelled` event is appended, so an exact retry of the
admission reports `duplicate` with `pending: false` instead of resurrecting a
prompt the operator dropped. An unknown id, or an id from another Session,
returns `accepted: false` with `reason: "unknown"`; an already promoted prompt
returns `accepted: false` with `reason: "promoted"` because interrupting a
committed turn is `cancel`/`cancel_if`, not this command. Re-cancelling is
accepted as a duplicate and appends no second event.

A cancelled identity is terminal: admitting the same `session_id`/`input_id`
again fails with `input_conflict` instead of resurrecting the dropped prompt or
returning a receipt whose prompt never runs. A client that wants to re-send a
cancelled prompt admits it under a fresh `input_id`.

### Operator-requested compaction

`request_compact` takes `session_id` and asks for one compaction at the next
settled assistant boundary even when the budget gate is under its threshold. The
request is durable — `compaction.requested` — and idempotent: a retried command
reports `duplicate` instead of queueing a second compaction. One attempt answers
it at that boundary, appending `compaction.settled` with `compacted`, so a
summarizer the provider keeps refusing cannot pin a Session; asking again is what
asks for another try.

The request is itself the trigger, so a forced pass runs even on a runtime
without configured context limits (it summarizes the selected history instead of
retaining the exact last provider request, and elision stays off). Every other
gate still applies: only a completed answer is cut, never a tool continuation or
a reverted transcript. Automatic compaction keeps its own trigger; this command
does not change the budget.

An idle Session honours the request at its next provider turn rather than
compacting in the middle of nothing, which is where a Session's settled boundary
actually exists.

### Archiving

`archive` takes `session_id` and `archived`. Archiving is a catalog fact: it
writes the Session's `archived_at_ms` (null when cleared), appends
`session.archived`, and touches no message, run, inbox or approval row, so a
Session may be archived while a drain is active and restored with
`archived: false`. The snapshot reports `archived_at_ms`, and an unarchived
Session reports `null`. Archiving never initializes a Session: an unknown id
fails with `invalid_request`.

### Removal

`remove` takes `session_id` and deletes everything the Session owns — its
conversation, inbox, runs, tools, approvals, jobs, schedules, placement, lease
and event log — after interrupting any active drain and stopping the
in-process tasks that belong to it. Stopping those tasks is required, not
cosmetic: an armed cron or wakeup admits through the inbox, which re-creates
the Session row.

There is no tombstone, so the identity can be created again from scratch. A
child keeps its own rows and loses only its lineage edge, matching the
product's rule that removing a Session does not delete its forks. An unknown
Session is reported as `{accepted:false, reason:"unknown"}` rather than
refused, so a half-finished removal can be retried by the caller.


### Inline image admission

`admit.attachments` accepts up to eight PNG, JPEG, GIF or WebP images. Each
attachment carries `mime`, base64 `data` (at most 8 MiB), and optional object
`metadata` (at most 64 KiB). Metadata is presentation evidence, not provider
instructions. It participates in exact-retry identity along with the bytes.
An image-only input may use an empty `input.prompt`; an input with neither text
nor attachments is rejected.

Promotion journals the attachments in `input.promoted` and commits their image
parts in the same transaction. Presentation metadata survives replay and fork;
provider adapters send the image bytes without forwarding that metadata.
The product facade sends a metadata object, including when it is empty, so an
older engine that lacks product attachment projection rejects the request
instead of accepting an image that disappears from product history.

### Idle Session initialization

`initialize` takes `session_id` and `title`. It creates an idle identity in the
engine database and binds it to the engine workspace, without admitting an input
or scheduling model execution. `snapshot` and `sessions` immediately see it.
An exact retry returns `duplicate: true` and preserves edited metadata and the
journal cursor; reusing an identity belonging to another workspace fails.
The product initializes identity before publishing its durable native placement.

### Session model selection

`select_model` takes `session_id` and `binding` (`protocol`, canonical wire
`model`, optional exact `route_id`, and optional host-advertised `variant`), or
`binding: null` to reset to the configured default. The Runtime
validates that its configured provider can select that model without changing
route, endpoint or credential source before committing `session.model.selected`.
An identical selection is a no-op. Unsupported models/routes fail without
changing the prior binding or waking the Session.

The next provider-turn boundary reads the committed binding. A request already
in flight retains its original provider, and another Session retains its own
selection/default. Provider-start evidence, assistant identity, native token
counting and compaction use the provider actually selected for that turn.
`snapshot.model_selection` exposes the durable binding, or null for the default.
A fork inherits selection at its explicit message boundary, or the parent's
latest selection when no boundary was requested. Reverting transcript history
does not alter this configuration binding.

`model_catalog` exposes available variant names alongside each route. A variant
must be declared by the host, preserves the route's protocol/model identity,
and cannot substitute an endpoint or credential source. The binding includes
its variant across restart, fork and provider-turn boundaries. An older engine
that does not advertise variants cannot accept a product variant selection.

Host route manifests may supply `request: {body, headers}`, a `variants` array
of `{id, body, headers}`, and `primary: true` on one route to declare the default
route's variants. Variant bodies recursively merge over base generation
options; headers override case-insensitively. Structural transcript/tool fields,
streaming controls and credential headers are rejected, and options are bounded
to 64 KiB. Responses prefix-cache affinity includes the effective request
options, so a generation-profile change does not reuse a previous profile's
continuation accidentally. The public catalog exposes names, not parameters
or credentials.

### Explicit unknown-tool recovery

`recoveries` takes `session_id` and optional exclusive `after` call ID. It returns
`calls` (at most 100) and `has_more`; each call includes its ID, run ID, tool,
`outcome: "unknown"` and nullable `resolution`. Original arguments are omitted.

`resolve_recovery` takes `session_id`, `call_id`, a unique `operation_id` (1–128
ASCII alphanumeric/underscore/hyphen characters), and `decision: "retry" |
"abandon"`. It atomically records the controller decision and admits one steer
input. The receipt includes `input_id` and `admitted_seq`; an exact retry returns
the same receipt, while conflicting reuse fails. The original outcome remains
unknown. Optional `resume: true` explicitly schedules an advisory wake after
admission; it never forces another provider turn for an already-promoted exact
retry. A retry requests inspection and, if necessary, a fresh authorized tool
call; it never replays the previous dispatch. An abandon requests continuation
without retrying that operation. The Session must be idle and Location-bound.

By default neither command schedules model work. Use explicit `resume: true`,
a separate `resume`, or a later prompt to promote the durable instruction.
See [ADR-16](docs/adr/0016-explicit-tool-recovery.md).
