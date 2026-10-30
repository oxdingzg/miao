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

### Reverse-call cancellation

Host reverse calls use `product_tool` or `hook_tool` with a `bridge_id` and
`params.session_id`. Cancelling the Session removes its pending reply slots and
emits the corresponding `product_tool.cancel` or `hook_tool.cancel` notification
with the same `bridge_id` and `params: {session_id, bridge_id}`. The host should
interrupt only the matching Session's active callback, release scoped resources,
and suppress late replies. Unknown notices are safe to ignore. Connection loss
or client close must also release host callbacks. A host that ignores a notice
does not prevent the engine from settling its own cancelled drain.

## Methods

| Method | Params | Result |
| --- | --- | --- |
| `subscribe` | `session_id`, `after` | `{accepted:true}` |
| `unsubscribe` | `session_id` | `{accepted:true}` |
| `admit` | `input`, `resume`, `attachments?` | `Admission` |
| `resume` | `session_id` | `{accepted:true}` |
| `cancel_input` | `session_id`, `input_id` | `{accepted:bool, reason?}` |
| `input_status` | `session_id`, `input_id` | admission receipt (see below) |
| `edit_input` | `session_id`, `input_id`, `prompt` | `{session_id, input_id, delivery, duplicate}` |
| `cancel` | `session_id` | `{accepted:bool}` |
| `archive` | `session_id`, `archived` | `{accepted:true, archived}` |
| `pin` | `session_id`, `pinned` | `{accepted:true, pinned}` |
| `remove` | `session_id` | `{accepted:bool, reason?}` |
| `request_compact` | `session_id` | `{accepted:true, duplicate, pending}` |
| `recap` | `session_id` | `{seq, text, through_message_seq, messages_after_checkpoint, total_messages}` |
| `request_compact` | `session_id`, `through?`, `focus?` | `{accepted:true, duplicate, pending}` |
| `select_agent` | `session_id`, `agent` | `{agent_hash, changed}` |
| `select_account` | `session_id`, `credential_id` (string or null) | `{binding, account, changed}` |
| `product_permission_evaluate` | `source`, `request` (active reverse-call facts) | `{effect, rules, authority_revision}` |
| `permission_pattern_list` | — | native-owned standing patterns for this Runtime's workspace |
| `shared_permission_snapshot` | — | bound shared Root/context snapshot and Root change cursor; shared Runtime only |
| `shared_permission_changes` | `after: {authority,seq}`, `limit` | bound Root changefeed page; shared Runtime only |
| `permission_pattern_snapshot` | — | atomic native standing-rule snapshot and change cursor |
| `permission_pattern_changes` | `after`, `limit` (1–256) | ordered durable changes after a workspace cursor |
| `permission_pattern_put` | `rule` (allow only) | persisted pattern with ID, workspace, source and timestamp |
| `permission_pattern_remove` | `rule_id` | `{removed:bool}` |
| `events` | `session_id`, `after` | `Event[]` (page ≤ 100) |
| `snapshot` | `session_id`, `metadata_only?` | committed Session snapshot; metadata-only replies omit `messages` |
| `sessions` | — | `string[]` (Session ids) |
| `config_reload` | — | `{generation, changed, unchanged, unsupported, lsp?, mcp?, context?}` |
| `session_children` | `session_id` | `{session_id, children[], truncated}` (see below) |
| `config_reload` | — | `{generation, changed, unchanged, unsupported, lsp?, mcp?}` |
| `fork` | `session_id`, `target_session_id`, `message_seq?` | `{target_session_id}` |
| `revert` | `session_id`, `checkpoint` | `{checkpoint, from_seq, reverted}` |
| `unrevert` | `session_id` | `{restored}` |
| `approve` | `session_id`, `response` | `{accepted:true}` |
| `approve_persistent` | `session_id`, `response` (allow only) | `{accepted:true}` |
| `permission_saved_snapshot` | `workspace`, `rules` (complete saved-allowance snapshot, including empty) | `{accepted:true}` |
| `history` | `session_id`, `selected` | `Message[]` |
| `history_page` | `session_id`, `before_seq?`, `limit?` | `{session_id, messages[], has_more, next_before}` |
| `context` | `session_id`, `epoch?` | Context Epoch or null |
| `compact` | `session_id`, `compaction_id`, `through_message_seq`, `summary` | checkpoint |
| `recall` | `session_id`, `query`, `limit?`, `before_message_seq?` | bounded matches |
| `questions` / `answer_question` | `session_id`, … | pending / accepted |
| `state` / `update_state` | `session_id`, … | Session state |
| `jobs` / `job` / `cancel_job` | `session_id`, … | background jobs |
| `crons` / `cancel_cron` | `session_id`, … | schedule |
| `wakeups` / `cancel_wakeup` | `session_id`, … | schedule |
| `vcs_status` | `session_id` | workspace Git state, or `{repository:false}` |
| `shutdown` | — | terminates the process |

`snapshot` defaults to the full transcript. Catalog and peer readers can set
`metadata_only: true` to avoid projecting or serializing message bodies while
retaining the same cursor, identity, pending work and Session state. An omitted
`messages` field is not evidence that the Session has no history.

`event` notifications are committed canonical events; `progress` notifications
are ephemeral provider frames that are not durable and may be followed by a
`resync`. A `config` notification carries the report of a reload that changed
at least one section — the same object `config_reload` replies with — and is
sent to every stdio subscriber because a reloaded configuration is
process-wide rather than Session-scoped. It arrives whether the host, another
client, or the standalone poller triggered the reload, so a host can show a
change it did not request; an unchanged reload sends nothing. A reload the
engine refuses on its own — a standalone poller reading a malformed file —
is announced on the same channel as `{"changed": [], "error": "..."}`, because
that failure otherwise exists only in the engine's stderr. A slow stdout
consumer applies backpressure through the pipe: the
writer waits for the reader instead of terminating the engine, and only a
closed pipe (a dead host) or `shutdown` ends the stream. The durable cursor
still makes replay→live independent of any transient frame, so a client that
does disconnect can resume from committed events.

### Waiting notices

A turn can hold for minutes without writing anything durable: an approval the
user has not answered, a slow shell command, a language server or an MCP server
that has not replied. Both waits announce themselves on the `progress` channel
so a client can distinguish them from an engine that died.

| Kind | Emitted while | Payload |
| --- | --- | --- |
| `provider.waiting` | the provider has produced no first token | `session_id`, `run_id`, `step`, `attempt`, `elapsed_ms` |
| `tool.waiting` | a serial call is dispatched and not settled | `session_id`, `run_id`, `step`, `call_id`, `tool`, `elapsed_ms` |

`tool.waiting` repeats every five seconds for one outstanding call, covers the
approval, hook and execution phases in between, and stops as soon as the call
settles. Calls settled by the read batch never announce a wait, and neither
notice is a substitute for a durable fact: both are absent from the journal,
from `events`, and from `export`, and neither counts as turn progress.

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

### Session children

`session_children` takes `session_id` and answers the Sessions forked from or
delegated to by it: `{session_id, children[], truncated}`. Each child carries
`session_id`, `title`, `parent_message_seq`, `message_count`, the catalog
timestamps (`created_at_ms`, `updated_at_ms`, `archived_at_ms`, `pinned_at_ms`),
`status` and `run`. Order is oldest first; at most 200 children are returned and
`truncated` says whether any were left out.

`status` is `busy` while the child has a running run and `idle` otherwise, so it
reuses the execution vocabulary instead of inventing a second one. `run` is the
child's most recently opened run — `{id, state, started_at_ms}` or null when it
never ran — because `state` is how the child ended (`completed`, `failed`,
`cancelled`, `interrupted`), which is the difference between "finished" and
"never started". Archived children stay in the list: archiving is a catalog
preference, not a retraction of the delegation. A Session without children
answers an empty list; an unknown `session_id` is `invalid_request`.

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

### Interactive request identities

Question IDs are opaque, Session-scoped request identities. A worker may issue
several interactive `ask` requests during one tool call; every ask gets its own
durable identity even when its input is identical. An exact retry of a settled
answer is idempotent only for that identity and cannot settle a later ask. The
stored request still binds the source run/call, workspace and input hash.

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

### Input receipt

`input_status` takes `session_id` and `input_id` and answers where one admitted
input is now, so a reconnecting client can place a prompt it sent earlier
without replaying every `input.*` event:

```json
{
  "session_id": "s",
  "input_id": "one",
  "state": "promoted",
  "delivery": "steer",
  "admitted_seq": 4,
  "admitted_at_ms": 1730000000000,
  "promoted": {"seq": 5, "recorded_at_ms": 1730000000100, "checkpoint": "..."}
}
```

- `state` is `pending`, `promoted`, `cancelled`, or `unknown`. An id this
  Session never admitted answers `unknown` with no other fields, because
  another Session's admission is not this caller's fact; an unknown
  `session_id` is `invalid_request`.
- A `pending` input carries `pending_ahead`: how many inputs of the **same
  delivery class** were admitted before it. Promotions run steer-first and take
  at most one queued item per idle boundary, so a single cross-class position
  would claim an order the engine does not promise.
- A `promoted` input carries `promoted`: the seq of the user message it became
  (the projection lands on the promotion event's seq), that event's local time
  and its checkpoint, which is the identity a transcript or revert names.
- A `cancelled` input carries `cancelled`: the seq and local time of the
  `input.cancelled` event that dropped it.
- Execution and failure are deliberately absent. Promotion starts a run whose
  outcome belongs to that run — `run.finished` and the Session's run state —
  not to the admission receipt.
### Pending-input editing

`edit_input` takes `session_id`, `input_id` and the new `prompt`, and rewrites a
still-pending input in place. The admission identity, delivery class and
admission order are preserved, so an edited steer keeps its place among steers
and an edited queued item keeps its place in the queue; only the text the
eventual user message carries changes. Editing appends an `input.edited` event
carrying digests of the previous and new text — an audit of the change, not a
second copy of the prompt — and appends nothing when the text is unchanged,
which instead reports `duplicate: true`.

Only `pending` inputs are editable. A promoted input is already a transcript
message that a revert, not an edit, would move; a cancelled identity is
terminal. Both fail with `invalid_request` naming the input's state, as does an
id this Session never admitted. `prompt` is bounded to 1 MiB, matching
admission. Attachments, command references and agent references are not part of
an edit: they were admitted with the prompt, and a client that needs different
media or references cancels and admits again under a fresh id.

A product "take back and rewrite" therefore needs no separate command: read the
input with `pending_inputs`, `edit_input` it, or `cancel_input` it and restore
the text in its composer.

Because the edit changes what the admission identity now means, a later exact
retry of the original `admit` — same id, pre-edit text — conflicts instead of
silently reverting the rewrite.

### Session agent selection

`select_agent` accepts a host-resolved `agent` manifest (ADR-0017): `name`,
optional `semantics`, `instructions`, `tools: {allow, deny}`, `permissions`,
`model` (the same binding as `select_model`, including its optional variant),
and collaboration `mode` (`build` or `plan`). Optional `request` uses the existing
bounded body/header override contract; `steps` narrows the operator turn budget.
Unknown fields are refused.
Names are bounded to 128 bytes, instructions to 64 KiB, tool-name lists and
permission rules to 256 entries; permission patterns and model bindings are
validated before admission. Tool lists use exact registered engine names;
unknown names are refused. An omitted or empty `allow` leaves the registered
surface available, while `deny` always removes its entries.

The engine appends `session.agent.selected` with the manifest and its SHA-256.
Selecting identical content reports `changed:false` and appends nothing. The
snapshot exposes the selected name, semantics and `agent_hash`; forks inherit
only the manifest that existed at the chosen history boundary.

Each provider turn takes an immutable agent and effective policy snapshot.
Instructions, effective tool names and the agent source participate in the
selected context fingerprint; the real provider request profile carries the
agent identity and hash. Tool restrictions apply at dispatch as well as in the
advertised schema, including the parallel-read path. Permission rules combine
with the configured policy using its deny-over-ask-over-allow ordering and
cannot lift a configured denial or a disabled capability. The effective policy
revision includes the manifest hash, and changing agents transactionally denies
pending approvals so a late reply cannot authorize a call under old authority.

The agent's model pin applies only when the Session has no explicit model
selection. Collaboration mode applies to both the system instructions and the
actual tool execution boundary. A turn already in flight keeps its chosen
manifest; the next provider turn observes the newly selected one.

The product bridge uses optional `ordered_permissions` with
`semantics:"ordered-wildcard-v1"`, an ordered `rules` array of
`{action,resource,effect}`, and `bindings` mapping exact native tool names to
`{action,resource?,explicit?}`. Resource selectors are `native` (default),
`command` (Bash AST resources or explicit argv) and `program` (the executable of
an interactive terminal), `{input:"field"}` (a bounded direct input property)
and `{literal:"value"}` (a bounded fixed resource). Last matching rule wins within this layer, preserving
late allow exceptions; all resources must pass. An explicit binding ignores a
catch-all action rule. A missing command input asks rather than matching a
workspace directory. The host's `auto` classifier mode is explicitly unsupported
by the initial product adapter; a switch to such an agent fails without changing
the selected manifest.

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

### Recap

`recap` takes `session_id` and returns a human-facing summary of the Session as
`{seq, text, through_message_seq, messages_after_checkpoint, total_messages}`,
appending one `recap.created` event that carries the same text. It is a review
artifact, not a context operation: it calls no provider, writes no checkpoint
and appends no message, so `selected_history` is unchanged by it and the next
request carries exactly what it would have carried otherwise. `through_message_seq`
is the latest compaction checkpoint (null when the Session has none) and
`messages_after_checkpoint` counts the window the provider still sees.

An idle Session honours the request at its next provider turn rather than
compacting in the middle of nothing, which is where a Session's settled boundary
actually exists.

### Workspace Git state

`vcs_status` answers "what changed in this Session's workspace" from one
`git status --porcelain=v2 --branch -z` call. It is read-only: no index write,
no lock, no network, and `ahead`/`behind` come from the local branch header. The
answer carries `branch`, `detached`, `upstream`, `ahead`/`behind` when an
upstream exists, and `files[]` with `path`, `original_path`, the raw `index` and
`worktree` columns, and a normalized `kind` (`untracked`, `conflicted`,
`renamed`, `copied`, `added`, `deleted`, `modified`, `type-changed`, `changed`).
Paths are relative to the Session's location root.

A location that is not inside a repository answers `{"repository": false,
"root": …}` instead of failing. At most 5000 entries are returned; a larger
workspace sets `truncated: true` and still reports the true `file_count`. A git
call that does not finish within ten seconds fails with a reason rather than
holding the drain.
A request may name a **scope**. `through` is the message sequence the checkpoint
must cut at: that range is summarized and everything newer stays in the selected
history verbatim, so the cut doubles as the retention target. `focus` is the
operator's own words for what the summary must keep; it is carried into the
summarizer prompt next to the excerpt, and the durable state block is retained
regardless. Both fields are optional and absent means the previous behaviour.

A scope is honoured exactly or refused, never clamped: a `through` that is not a
closed assistant boundary fails the attempt with a reason (reported through the
run's `compaction.failed` progress notice and recorded as
`compaction.settled{compacted:false}`), and a `focus` that is empty or longer than
2000 characters is refused when the request is recorded. A retry while a request
is pending is idempotent only for the same scope; a different scope is a
conflict rather than a silent replacement.

### Archiving

`archive` takes `session_id` and `archived`. Archiving is a catalog fact: it
writes the Session's `archived_at_ms` (null when cleared), appends
`session.archived`, and touches no message, run, inbox or approval row, so a
Session may be archived while a drain is active and restored with
`archived: false`. The snapshot reports `archived_at_ms`, and an unarchived
Session reports `null`. Archiving never initializes a Session: an unknown id
fails with `invalid_request`.

### Pinning

`pin` takes `session_id` and `pinned`. A pin is a list preference the engine
owns, so a second client orders the shared catalog the same way: it writes the
Session's `pinned_at_ms` (null when cleared), appends `session.pinned`, and
deliberately leaves `updated_at_ms` alone — a pin is not Session activity and
must not read as the Session having been used. The snapshot and `catalog_info`
report `pinned_at_ms`. Unlike `archive` an unknown id fails with
`invalid_request`: pinning never initializes a Session.

 — its
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


### Inline attachment admission

`admit.attachments` accepts up to eight PNG/JPEG/GIF/WebP images, `application/pdf`
documents and UTF-8 `text/*` files. Each carries `mime`, canonical base64 `data`
(at most 8 MiB), and optional object `metadata` (at most 64 KiB). Empty text files
may have empty data. PDFs must start with a PDF header; invalid UTF-8 text is
rejected before admission. An attachment-only input may have an empty prompt.

Bytes and metadata form durable retry identity. Promotion/replay/fork retain
image or file parts with the original bytes. Product projection reconstructs
attachments, including their name, description, client path and source range.
The product host snapshots bounded `blob://`, local `file:` and HTTP(S) references
before admission, so replay does not need the original source URI.

Host model-route manifests may declare `input_modalities` using the product's
catalog values (for example `["text", "image", "pdf"]`). Empty/absent declarations
remain unknown. Each adapter normalizes a request copy: text files become UTF-8
text; unsupported images/PDFs become explicit text placeholders while durable
history stays intact. PDFs use Anthropic document blocks, Responses input_file,
and Gemini inline_data. Chat Completions uses the same PDF placeholder as the
product protocol contract. Provider-native counting uses normalized media too.

Product admissions always include a metadata object, even when empty. An older
engine that cannot project these attachments rejects unsupported input rather
than accepting it and losing product history.

### Idle Session initialization

`initialize` takes `session_id` and `title`. It creates an idle identity in the
engine database and binds it to the engine workspace, without admitting an input
or scheduling model execution. `snapshot` and `sessions` immediately see it.
An exact retry returns `duplicate: true` and preserves edited metadata and the
journal cursor; reusing an identity belonging to another workspace fails.
The product initializes identity before publishing its durable native placement.

### Session account selection

`select_account` accepts an opaque `credential_id` or null and resolves it only
against registered host routes (ADR-0020). A route may carry trusted account
metadata `{id:string|null, model_key:string, default:boolean}`. The logical model
key, not a wire model name or a route-id prefix, determines the family. The
metadata stays out of public model catalogs; no endpoint or secret can be passed
in a controller account command.

The command retains the current explicit variant. Missing or ambiguous accounts,
unsupported variants and incompatible opaque history fail before mutation. Null
restores that logical model's configured default account. Account intent is its
own `session.account.selected` fact rather than an explicit model pin, so agent
model defaults remain effective and ordinary model/variant changes retain an
account pin. Explicit account-specific model aliases update both axes atomically.
The snapshot exposes `account_selection`, and forks inherit it at the selected
history watermark.

The product bridge enumerates usable alternative credential references without
changing the global active connection, and the credential broker alone owns
refresh. External host manifests must declare account metadata to support
selection; a non-bearer default chain can use `id:null` without inventing a
stored credential.

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
route's variants. Optional `default_variant` selects a declared tier when no
explicit variant was requested, independently of other variants' options.
Variant bodies recursively merge over base generation
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


### Host route authentication

Host route `auth` applies to both named routes and the owner-default primary.
It changes only the declared auth style, bounded static headers and supported
literal query parameters; it retains the configured endpoint, credential source,
Responses capability contracts and fallback secondary. Credential-owned and
transport-owned headers cannot be supplied through `auth.headers`. Header names
merge case-insensitively, and explicit generation-variant headers override the
corresponding static host defaults exactly once. Chat query values are encoded
as data; unsupported auth styles or protocol/query combinations fail explicitly.
Advisory count requests retain the same static host routing headers.

### Exact permission grant storage

Schema version 13 adds `engine_permission_grant` for durable exact scopes.
A scope binds the workspace, opaque effective-authority revision (including
agent manifest), tool, resource, canonical target set, and exact input digest.
Target strings are literal identifiers; no wildcard or prefix matching occurs.
Scope decoding rejects unknown fields, control characters, invalid digests,
more than 64 targets, and encodings larger than 64 KiB. Stored scope bytes are
validated against the requested scope before a lookup can succeed.

Schema version 14 adds `engine_permission_request_scope`. The Runtime snapshots
its trusted exact scope in the same transaction as `approval.requested`.
`approve_persistent` accepts the same bound response as `approve`, with decision
`allow` only. Resolution atomically commits the stored scope, approval state and
`approval.resolved` event (`persistent: true`). Missing legacy request scopes,
forged, expired, cancelled and already-resolved requests cannot create grants.
An older engine rejects the new command; hosts must not fall back to once.

Capability and explicit-deny checks precede grant lookup. Effective policy/agent,
actual tool access, prepared targets, configured extension identities, process
runner and lifecycle hooks bind the authority revision. Changed scope asks
again; a matching scope records `permission.grant.used`. Grants survive engine
restart and are reusable across Sessions in the same workspace. They never
become wildcard rules or TypeScript permission rules. Caller-owned extension
transports use per-instance identity so grants cannot outlive that boundary.
The Store also exposes exact revocation primitives.

### Rule queries bound to a product-tool call

`product_permission_evaluation: 1` in `--capabilities` advertises
`product_permission_evaluate`. The controller copies `session_id`, `bridge_id`,
`call_id` and `message_seq` from its current `product_tool` reverse frame into
`source`. `request` contains nonempty `actions`, nonempty `resources`, and an
optional `explicit` flag. Both objects reject unknown fields; clients cannot
supply configured/saved rules or select another workspace.

```json
{"id":41,"method":"product_permission_evaluate","params":{"source":{"session_id":"s","bridge_id":1,"call_id":"host-call","message_seq":7},"request":{"actions":["read"],"resources":["public"]}}}
```

The Runtime captures the turn's resolved ordered agent rules and effective
policy revision when dispatching the host call. A later agent selection does
not rewrite that call's snapshot. Saved rules come from the attached canonical
workspace. Configured deny precedes saved allow. The returned authority revision
binds the workspace, captured policy/agent, native boundary descriptor and
layered rules; it is not an action token.

The source must still be pending on this controller's product connection, its
run must be running and its tool dispatched in the same workspace. Other
Sessions/calls/messages, replied or cancelled calls, replaced connections and
already-settled tools are refused. Hook frames and calls lacking Runtime-captured
authority cannot borrow this query.

This is a pattern-rule query only: it executes no action and creates no approval,
grant or remembered pattern. It does not replace capability/plan checks, host
cancellation handling or durable approval lifetimes. Product adapters must also
require saved-rule snapshot refresh before using the result for S6 migration;
the older additive projection cannot communicate revocation. Unsupported engines
must be rejected rather than falling back to caller-supplied rule evaluation.

### Captured commands and named agent references

`admit.input.command` captures `name`, raw `arguments`, optional attribution `source`,
`agent`, product `model`, `subtask`, and trusted resolved `authority`. The host renders
positional arguments and captures definitions without executing shell substitutions or
reading referenced files. `input.agent_references` contains a trusted bounded `catalog`
of agent manifests and ordered `mentions` with source metadata. Both fields participate
in exact admission retry identity; changing either under an existing input key conflicts.
An empty command prompt remains an operator command record.

After promotion, the serialized Session actor writes `command.started`, then prepares
shell substitutions and file/directory references through native policy, approvals,
workspace confinement and cancellation. A command is a promotion barrier: later inputs
are promoted after its preparation settles. Shell substitutions retain operator shell
provenance and reuse the current run rather than closing it. Files are bounded to 1 MiB;
there are at most 32 substitutions/references and eight attachments. Mention offsets use
UTF-16 indices to preserve product source coordinates.

Captured command/agent model defaults are validated against the active account and
provider history before application. Named subtasks use native child Sessions, the
parent task authority and the captured child manifest; nested subtasks are refused.
`command.completed` atomically replaces the selected user message's prepared parts;
`command.failed` preserves a visible diagnostic. Forks retain the command chip,
settled preparation state, reference sources and operator shell provenance. A command
cursor before preparation settlement cannot be forked.

A preparation already marked started after restart is failed as unknown and never
replayed. Exact retries do not rerun substitutions or child Sessions. Schema version 15
is a semantic reader guard: older engines would interpret an unprepared command as
ordinary prompt text and ignore its authority and once-only preparation ledger.

### Session file snapshots and three-phase revert

Native mutating tools (`write_file`, `edit_file`, `apply_patch`) record their
workspace-relative targets. At each settled assistant boundary the engine captures
those paths into a content-addressed manifest and blob store beside the engine
database, merging with the previous manifest so an untouched path still restores.
A path deleted since the previous snapshot is recorded as absent. Capture skips
files above 8 MiB and keeps the newest 20 snapshots per Session (plus any snapshot
a staged revert references); blobs are pruned only when no kept manifest or staged
pre-image references them. Snapshot records are retained, so a pruned snapshot
reports `available: false`.

`revert_stage {session_id,boundary_seq}` requires an idle Session and restores the
newest snapshot at or before the boundary. It records `revert.staged` with the
exact `restored`, `created` and `removed` file sets plus a pre-image of every path
it changes. Staging another revert first reverses the previous staged restore;
only one staged intent exists. `revert_clear` reverses that pre-image exactly and
records `revert.cleared`; it refuses without a staged revert. `revert_commit`
soft-reverts messages at or after the boundary (rows stay for audit and
`unrevert`), drops later compactions, records `revert.committed`, and clears the
staged intent. All phases refuse symlinks or paths that escape the Session's
workspace. A restore whose blob is missing fails before any staged intent is
recorded. The `snapshot` reply reports the staged revert when one exists.

### Incremental configuration reload

`config_reload` re-derives the configuration sections the engine owns from the
same origin startup used (`--policy`, `--config-sources` or `--config-dir` for
the policy; `--lsp-config`, `--config-sources` or `--config-dir` for LSP;
`--mcp-config` for MCP; `--model-routes-config` for the model catalog;
`--context-config`, `--skills-config`, `--references-config`, `--hooks-config`
and `--formatter-config` for the context carriers) and
reconciles the ones this build can swap in place. The reply is
`{generation, changed, unchanged, unsupported, …}`: `generation` advances only
when a section changed, `changed`/`unchanged` name top-level sections, and
`unsupported` names the sections this build does not reload yet rather than
implying they were applied. Every section is derived and validated before any is
applied, so a malformed edit or a boundary violation leaves all of them as they
were.

The policy section replaces the base policy a turn is derived from and, in the
same swap, the capability gates and web client that policy implies — a
tightened policy left running beside the old gates would check one thing and
enforce another. Gates are applied first, then the policy: that order can only
add a refusal ahead of the new rules, never permit a call the old ones denied.
A turn that already took its policy snapshot keeps it and the next turn reads
the new one; approvals carry the old revision and are therefore refused with
`ApprovalMismatch`, so a tightened policy never inherits an approval granted
under the looser one. The startup invariants are re-checked and a reload that
would break one is refused: process authority requires the database outside the
workspace and credentials outside it, and MCP requires external authority.
A Session with no recorded policy origin (`unsupported` contains `policy`)
cannot reload that section.

The LSP server set is reconciled per server by name and configuration. An
unchanged server keeps its connection and is never restarted; a changed or
removed server is dropped, and a changed or newly configured server is started
again on next use, so a reload never spawns a process by itself. A server the
plan adds counts as a change: the reconcile swaps the plan, and only then can a
later request reach the new server. The `lsp` object in the reply lists the
exact `changed`, `unchanged` and `removed` server names. A derivation error (invalid
JSON, unknown key, duplicate extension) changes nothing and fails the command;
the running configuration stays as it was. A Session that never had an LSP
registry at startup (`unsupported` contains `lsp`) cannot gain one without
restarting the engine.

The MCP server set is reconciled by server name and configuration fingerprint.
An unchanged server keeps its connection, its catalog watcher and its child
process. A changed or added server is connected before its predecessor is
closed, so a rebuild that fails leaves the previous connection serving and is
reported in `mcp.failed` as `{server, error}` instead of failing the reload; a
failed server that had no predecessor simply stays absent. A removed server's
tools disappear, its watcher exits and its child process is killed. The `mcp`
object lists the exact `changed`, `unchanged`, `removed` and `failed` names.
List-level violations (more than eight servers, duplicate names, an invalid
authority revision) are refused before anything is touched, and a derivation
error (invalid JSON, unknown key) fails the command with every section as it
was. A Session started without `--mcp-config` (`unsupported` contains `mcp`)
cannot gain MCP servers without restarting the engine.

The model catalog is rebuilt from `--model-routes-config` layered over the base
provider startup built from the operator's transport flags. The derived catalog
and its per-model context limits are compared with what is running and swapped
only when they differ; `models` appears in `changed`/`unchanged` with no
per-route sub-object. Session model bindings are durable facts and are not
rewritten: a binding whose route the new catalog no longer registers fails its
next turn with an explicit error instead of silently falling back to another
model. A malformed manifest names its file, changes nothing and fails the
reload, so the previous catalog keeps serving. A Session started without
`--model-routes-config` (`unsupported` contains `models`) cannot gain routes
without restarting the engine, and the manifest path joins the standalone
poller's watched set.

The context section re-reads the five host files that carry instruction
sources, skill directories, read-only references, lifecycle hooks and the
formatter registry. Each part is compared with what is running and swapped
through `Tools` only when it differs, so an edit to one file does not rebuild
the others; a reference edit moves the read scope it grants in the same swap.
The `context` object lists the exact `changed` and `unchanged` part names
(`sources`, `skills`, `references`, `hooks`, `formatter`), and `context` also
appears in the top-level lists. A part the operator never supplied cannot
appear on reload. A file that fails to parse, violates its bounds, or names a
reference that cannot be resolved fails the command with its own path in the
error and leaves every section as it was. A turn that already assembled its
context, read its hooks or formatted a file keeps the snapshot it took; the
next one sees the edit. The five paths join the standalone poller's watched
set.

The standalone entry has no host to call the command, so it polls the same
sources every two seconds (`mtime` plus size, not an OS watcher) and runs the
same reconcile. A tick that lands while a Session is draining is skipped, so no
turn observes half a change; a failed derivation is reported once and retried
only when a file changes again.

### Injected context

`{"type":"inject","session_id":"...","input_id":"optional-retry-key","text":"...","source":"skill:name"}` commits one `message.synthetic` history fact. The source is a bounded attribution label, not a command or credential. Injection creates no inbox row and does not start a provider turn. The host may request advisory `wake` afterwards; this drains eligible pending inbox work without forcing continuation. Unlike explicit `resume`, `wake` leaves an idle Session with no eligible input idle. An exact retry with the same Session and input identity reconciles; changed text/source conflicts. Forks preserve the synthetic record and original timestamp rather than promoting it as an operator prompt. Text is bounded to 1 MiB.

If injected context arrives between a model tool call and its results, the immutable transcript keeps admission order; provider history defers that context until the tool block closes, preserving required tool-result adjacency.

### Transcript page

`history_page` reads one bounded window of the stored transcript, starting at
its recent end, so a preview or a bottom-anchored view never serializes the
whole Session. `limit` defaults to 50 and is clamped to 1–500. `before_seq`
pages towards older messages; omitted, the window is the newest page.

The reply is `{session_id, messages[], has_more, next_before}`. Messages are
ordered oldest-to-newest *within* the page even though the read walks backwards,
so a client can append them above the current view without reversing them.
`has_more` says an older neighbour exists, and only then is `next_before` the
seq to pass as the next `before_seq`; the last page answers `has_more: false`
and a null cursor rather than inviting a round trip that returns nothing.

Each message carries `seq`, `role`, `content`, `checkpoint`, `recorded_at_ms`
and `synthetic`. The checkpoint is the stored-transcript identity that a revert
names — unlike `history` with `selected: true`, which is the provider view and
has no checkpoints. `synthetic: true` marks injected context, which is a
message but not an operator prompt. Reverted and quarantined messages are
absent, the same projection the rest of the Session reads. An empty Session is
an empty page, not an error; an unknown `session_id` is `invalid_request`.

### Operator shell records

`{"type":"shell","session_id":"...","call_id":"optional-operation-key","command":"...","timeout_ms":120000}` admits a durable operator operation and returns its receipt before execution. `shell_status` takes `session_id` and `call_id` and reads that same identity. An exact retry reconciles; changed command/timeout conflicts. Missing keys are generated. Commands are bounded to 32 KiB and timeouts to the existing process runner's 1–120000 ms range.

The Session actor serializes operator shells with model drains. Shells use the native workspace process runner, bash preparation, capability/agent/plan policy, exact bound approvals, cancellation, output limits and sandbox. `shell.started` is an authorized operator dispatch, never an assistant tool call. `shell.ended` records output, nullable exit code, reason, duration, truncation and `origin:"operator"`; the output and run settlement commit together. A policy/preparation refusal or cancellation before dispatch records `shell.refused` and no execution block. Session interruption also durably refuses queued shells. No shell operation admits a user prompt or starts a provider turn; a later prompt sees a bounded attributed operator-result history block including its exit status. An advisory `wake` may drain already-pending inbox work.

Receipts are `pending`, `running`, `ended`, `refused`, or `unknown`. A claim whose process died has an unknown outcome and is never automatically redispatched, including after an exact retry. Generic model-tool recovery refuses operator calls; inspect the operator receipt/current workspace and explicitly issue a new shell identity if another execution is necessary. Recovery listings identify operator provenance.

The durable output is bounded by the process runner. Provider history retains a 16 KiB preview with a `recall` handle for the remaining captured output; `recall.tool_use_id` accepts the operator call identity and reports `origin:"operator"`. Forks preserve operator blocks, exit evidence and timestamps under new fork-local identities and recall handles, rather than fabricating user prompts or model tool calls.

The product `session.shell` HTTP payload accepts optional `id` (`evt_...`) for exact native retries. The facade waits for the durable outcome, projects normal shell blocks and carries execution evidence in shell metadata. An unknown/refused native outcome returns Conflict rather than claiming successful execution.
### Product-owned MCP OAuth

Product-native owners materialize authorized global remote MCP servers through a
scoped loopback HTTP route. The route forwards MCP protocol bodies/streams while
borrowing the product's URL-bound OAuth authority. Native manifests contain only
the ephemeral local route, never OAuth access tokens, refresh tokens or client
secrets. Browser login and registration use the existing product OAuth routes.
Missing or rejected grants surface an authentication failure and require login.

SDK Streamable HTTP and SSE connections use the same request-time authority.
An inter-process refresh lock covers re-read, SDK token exchange and durable
rotation. A generation/URL compare-and-set prevents an in-flight old refresh
from replacing a newly authorized grant or a changed server binding. Omitted
refresh tokens preserve the stored grant. Expiry and concurrent 401 retries
refresh one observed generation; bodies are replayed only after rejection.
Refresh discovery/exchange has a bounded deadline and errors contain a stable
authentication status rather than provider response bodies. The product scope
owns the loopback service, so restarting a native child reuses its authority.

`auth.style: "copilot"` selects GitHub Copilot authentication for Chat,
Responses or Anthropic Messages routes. OAuth credentials bound to the
`github-copilot` integration use the device grant's `refresh` token; the
provider's zero-expiry sentinel does not expire that device grant. Other
integrations retain ordinary expiry validation. Route manifests contain
credential references, never the token bytes. Enterprise account metadata
selects the Copilot API base, and product endpoint metadata selects the wire.

Copilot request metadata is derived after media normalization on each request:
root user turns use `x-initiator: user`, child Session and continuation/tool
turns use `agent`, and only requests containing images carry the vision header.
The interaction id follows the Session affinity scope. Anthropic beta flags
merge with host flags. Copilot Responses routes reject continuation contracts
that are only supported by the other explicit transport profiles.

Product-owned loopback registrations carry a host-computed `authority_revision`
(SHA256 of the original remote registration). Only the transient local URL is
normalized for exact permission grants; the trusted original revision, other
configuration and effective call-metadata environment values remain bound.
Thus restarting the product proxy preserves a grant, while changing its remote
URL, headers, client configuration or identity metadata asks again. The revision
is accepted only for an explicit loopback HTTP transport with no competing
headers, OAuth grant or process command. It is never a model tool argument.
Older binaries reject the unknown registration field rather than consuming an
unbound grant. Native replay descriptors retain their existing semantics.

### Bedrock Converse transport

The native `amazon-bedrock` provider uses the AWS SDK default credential chain
for environment, shared profiles, credential processes, SSO, and container or
instance identities. The SDK owns expiring credentials and SigV4 signing;
`--aws-region` and `--aws-profile` select the host identity configuration.
`AWS_BEARER_TOKEN_BEDROCK` or an explicit key credential source selects bearer
mode instead. Bearer sources are re-read each turn. Region selection applies
to primary and fallback requests. Credential files remain host-owned resources.

A trusted route manifest may declare a credential source
`{"type":"aws","region":"us-east-1","profile":"profile-name"}` without
placing credential bytes in the manifest. The profile is optional. Generic
bearer-based protocols reject this source. Workspace-owned AWS credential
resources are rejected, including when they arrive through SDK environment
configuration.

Converse event streams are CRC-validated by the SDK. Text, fragmented tool
arguments, signed reasoning, redacted reasoning, and usage are retained;
unknown or incomplete response content fails explicitly. Signed reasoning
records bind the exact provider and model before replay. SDK internal retries
are disabled so the engine request budget and fallback reservation remain the
transport authority. Stream corruption after response start is not retried.
Bedrock input token counts already include cache reads and writes; the
non-cached breakdown is derived without double-counting them.

Generation overrides support bounded `inferenceConfig` and
`additionalModelRequestFields` with protected identity/history/tool fields.
Host-declared prompt caching adds SDK cache points to the system prefix and
latest user message. Native engine release archives include the AWS dependency
notice and Apache 2.0 license alongside the project license.

### Native-owned standing permission patterns

`permission_patterns: 1` advertises the three pattern methods. They are
controller operations bound to the Runtime's canonical workspace; callers cannot
choose a workspace or provenance in their payload. IDs bind the workspace and
rule content, repeated puts preserve identity/timestamp, and removing an absent
ID is idempotent. Only allow rules are accepted; configured deny still wins.

Native rows live separately from the host projection in the additive optional
`engine_owned_permission_rule_legacy` table (schema 23; earlier formats use the unsuffixed name). They join saved rules during evaluation;
removal does not delete projected rows or exact-call grants. A compatible older
read-only database without this optional table has no native-owned patterns.
SQLite insertion constraints enforce the combined saved-rule budget for both
native and projected rows; full-budget content replays remain idempotent.
Writes fail transactionally. Capability
negotiation, not a guessed version string, identifies support.

These methods provide standing-policy storage and explicit controller editing.
They do not turn a rule query into an execution ticket, bind an `always` answer
to a pending subrequest, project changes into the product database, or retire
the existing TypeScript permission evaluator. Those S6 integration gates remain.

### Durable host permission assertions

`product_permission_requests: 1` advertises `product_permission_admit`,
`product_permission_status`, `product_permission_reply`, and
`product_permission_pending`. Admission takes the live `source` identity used by
`product_permission_evaluate` plus `input`: a host-generated `request_id`,
`facts` (ordered primary action followed by aliases, resources, explicit),
optional `save` patterns, display `metadata`, and optional `timeout_ms`.
Controller input cannot provide configured/saved rules or choose a workspace.
Every distinct assertion needs a new ID, even for identical facts. An exact
retry with the same ID returns its durable record; conflicting reuse fails.

Records bind runtime owner, workspace, Session, bridge, source tool, assistant
message, input hash, and captured authority revision. Replies provide source,
request ID, input hash, authority revision, and `once`, `always`, or `reject`.
The source must still be running and dispatched on the same connection. The
source slot remains locked through SQL commit, serializing mutations with reply
removal and bridge replacement. Current saved rules are re-read before replying;
a new deny prevents approval. Identical settled replies are idempotent while the
source is live; conflicting replies fail.

`always` atomically stores the explicitly supplied `save` patterns for the
primary action and resolves this request. Omitted/empty `save` remembers nothing,
matching the host permission contract. These are standing allow rules, never
exact-call grants. A pattern write failure rolls back every pattern and the
reply. Approval of this assertion does not execute or schedule a host action.
Host executors must still honor cancellation and their capability boundaries.

Pending requests emit `product.permission.requested` and resolution emits
`product.permission.resolved`. Source tool completion, run cancellation, and
abandoned-run recovery cancel pending requests transactionally; recovery does
not retry provider work. Requests default to no deadline; an optional deadline
is 1–600000 ms. Each Session admits at most 64 pending requests and admission
payloads are bounded to 16 KiB. The additive optional request table leaves the
existing schema version unchanged.

This is the durable backend for host subrequests. The product compatibility
adapter, product event projection, and removal
of the TypeScript evaluator remain separate S6 gates. Existing host tools do
not switch permission ownership merely because the capability is present.

#### Withdrawing one assertion

`product_permission_cancel: 1` advertises `product_permission_cancel` with
`source` and `request_id`. A live, bound caller can withdraw its own pending
assertion when its wait is interrupted. This resolves only that record as
`cancelled` with reason `caller_cancelled`; it does not reject siblings, save
patterns, or grant permission. The update and resolution event are atomic.
Exact retries do not emit duplicate events. Already terminal records are
returned unchanged, and an expired request remains expired. Foreign or inactive
sources fail the same binding checks as status and replies.

#### Replies and already-pending peers

A reject resolves this request and the already-pending requests in the same
Session. It does not reject another Session or a request admitted afterwards.
An allowed `always` with nonempty save patterns rechecks pending requests owned
by this Runtime in the same canonical workspace, including other Sessions.
Each live source uses its own captured agent/authority and the newly saved
rules: only allow results resolve; unmatched asks and configured denies are
preserved. Expired or inactive sources cannot inherit approval.

The bridge's source slots remain locked through the shared SQL transaction.
Patterns, the selected reply, peer resolutions, and their events commit or roll
back together. An exact retry of an already-resolved reply performs no sweep and
does not restore rules removed since that reply. These semantics match the host
permission service without enabling the product compatibility adapter.

#### Corrected rejection feedback

`product_permission_replies: 1` identifies peer-reply semantics plus optional
`message` on `product_permission_reply`. A nonempty reject message is preserved
as `feedback` on the selected durable record and its resolution event, with
reason `user_corrected`. Other requests swept by that rejection remain ordinary
`user_rejected` declines and do not receive the correction. Empty reject messages
mean ordinary decline; messages on once/always have no semantic effect, matching
the host service. Messages are bounded to 4096 UTF-8 bytes and reject NUL.

An exact response retry must match both the reply and normalized correction;
it cannot replace an existing correction. Invalid feedback leaves the request
pending without a resolution event. Legacy records without `feedback` decode
with no correction, and records without a correction omit the field. Consumers
must check this capability before sending message-bearing responses. The
capability does not activate the product adapter or turn a reply into an action
execution ticket.

#### Host auto-mode classification

`product_permission_auto: 1` advertises classification during host permission
admission. The dispatched source captures its agent's auto flag; selecting a
new agent or mode cannot change an already-running source. Configured denies
remain denied. Only an ask proven safe by the deterministic edit/bash classifier
becomes allowed, with reason `auto_allowed`; no standing pattern or exact grant
is written. Any defined `metadata.stdin`, including null, keeps bash an ask.
Other actions and unknown operations keep asking. Bash stays unknown on Windows.

A product-tool manifest may include `host_context: { directory, cwd }`. Directory
must canonicalize to the Runtime's Location; cwd, when present, must be absolute.
The host supplies its Location spelling and process cwd at startup so relative
edit resources resolve as they do in the host. Each source captures that context.
An absent context uses the native Location and native process cwd. No permission
request can override mode, cwd, workspace or this context. Rules continue matching
the original resources; only classification resolves paths lexically. The root
itself, escaping paths and sensitive paths remain unknown. Sensitive raw and
resolved paths are both checked conservatively.

Admission authority hashes bind captured mode and path context. Echo the record's
hashes when replying; `product_permission_evaluate` remains the rule-only query
and does not substitute for full admission. Classification does not execute an
operation or replace the executor's filesystem/capability checks. The product
permission adapter and complete S6 acceptance remain outstanding.

#### Policy denial evidence

`product_permission_diagnostics: 1` adds optional `denial` to records whose
reason is `policy_denied`. It is the actual native outcome (`effect: deny`,
effective `rules`, `authority_revision`) captured when admission or reply-time
rechecking denies the assertion. Later saved-rule changes do not rewrite it.
A reply-time denial can have a different diagnostic authority revision from the
record's admission binding; the latter stays unchanged for exact reply retries.
User rejection, cancellation and allowance do not manufacture policy evidence.
Legacy records without `denial` decode as unknown evidence and omit the field.
These are engine-produced diagnostics, not caller-provided policy or a new grant.

### Durable standing-rule projection cursor

`permission_pattern_changes: 1` advertises the snapshot and changes commands.
Both are controller operations bound to the Runtime’s canonical workspace;
callers cannot select a workspace. Bootstrap a product projection with
`permission_pattern_snapshot` (`workspace`, `patterns`, `cursor`), then consume
`permission_pattern_changes` with `after=cursor` and `limit` from 1 to 256.
The snapshot reads patterns and its cursor in one SQLite transaction, including
rules created before the journal existed. Do not bootstrap from the feed alone.

A page returns `workspace`, ordered `changes`, `cursor` and `has_more`. Each
change has `seq`, `recorded_at_ms` and either `{kind:"upsert",pattern}` or
`{kind:"remove",id}`. Resume after the returned cursor; an empty page retains
the supplied cursor. Sequence gaps can belong to other workspaces. A receipt is
committed in the same transaction as the pattern mutation, including patterns
saved by an always reply. Content retries and absent/foreign revocations add
no receipt. Receipt failure rolls back the mutation; a corrupt receipt fails
the page. This journal is projection evidence, never a second rule authority.

Product-side durable projection, acknowledgements, import retirement and
complete S6 migration remain separate work. This revision does not prune the
journal; retention and consumer acknowledgements require a separate design.

### One-time saved-rule handoff (backend prerequisite)

`saved_permission_migration: 1` advertises four controller-scoped commands:

- `permission_saved_migrate {project,rules:[{id,rule}]}` atomically replaces the old
  projection and records an immutable input receipt. Rules must be bounded allow
  rules; duplicate IDs and native projection IDs are rejected. Input ordering is
  irrelevant. Same-input retries return the receipt, including after revocation;
  changed input or project is rejected. Empty imports clear stale projected rows.
- `permission_saved_migration` returns the receipt, or null before handoff.
- `permission_saved_imported` returns currently active imported IDs and rules.
- `permission_saved_remove {id}` revokes one imported identity and retains its
  tombstone. Duplicate content stays allowed until all its imported identities
  are revoked. Independent native patterns remain independent.

Workspace is the Runtime controller's canonical workspace and cannot be supplied
in these commands. Legacy projection writes are rejected after handoff; rule
budget, receipt, provenance and revocation updates share SQLite transactions.
This does not create exact-call grants or widen workspace scope. Product
activation, imported-rule change projection and project/global/worktree scope
migration remain separate work; existing product owners do not invoke handoff.

### Imported-rule change projection

`permission_import_changes: 1` adds `permission_import_snapshot` and
`permission_import_changes {after,limit}` (1–256). Both bind to the controller's
canonical workspace. The snapshot pins the immutable migration receipt, active
imported IDs/rules and cursor in one read transaction, including pre-journal
imports and empty rule sets. Its cursor is independent of the native-pattern
journal; older pattern consumers receive no new variant.

One `migrated` change carries the receipt and full imported identity set, so a
handoff cannot be projected as a partial list across page boundaries. Actual
revocations append `removed {id,fingerprint}` in the same transaction; the
fingerprint binds each removal to its immutable workspace migration receipt. Exact import retries,
duplicate/foreign revokes and restarts do not append changes. Journal failure
rolls back the grant or revoke. Receipt/scope/identity corruption refuses the
whole page; a fresh atomic snapshot can rebuild from authoritative rows.

These commands supply projection evidence, never another authorization path.
Product imported-rule replicas, automatic handoff and broader scope migration
remain separate activation work.

### Model-free project permission control

`permission_project_store: 1` advertises the separate local stdio entry point
`miao-engine permissions --db PATH --project ID`. It opens only the dedicated
project permission database and binds one project for the process lifetime; no
workspace, model, provider, Session store or reverse tool bridge is initialized.
The inherited environment in the product client contains process basics without
provider credentials. The ordinary runtime protocol remains unchanged.

Requests retain the usual scalar `id`, `method` and optional `params` framing:

- `snapshot`: authority identity, bound project, revision, migration receipt and
  active rules in one read transaction.
- `migrate {rules:[{id,rule}]}`: one-time immutable legacy handoff, returning the
  current snapshot. An exact retry never restores revoked identities.
- `put {rule}`: idempotent native standing allow rule, returning the snapshot.
- `remove {id}`: scoped revoke, returning `{removed}`; duplicate removal is false.
- `shutdown`: acknowledge and exit after the response flushes.

Requests cannot choose another project, workspace or database. Unknown fields,
invalid input, deny patterns and unsupported databases are refused. The shared
16 MiB framing bound and discard/resynchronization behavior apply. The process
exits after five minutes without input, on EOF, shutdown or termination signal.
Read timeouts do not imply a rule mutation; write timeouts retire the transport
and require inspection of the durable snapshot before deciding on another write.

This is trusted local rule-management control, not a model authorization tool or
a Session execution owner. Runtime source/pending/always integration, product
activation and legacy write retirement remain open.

`permission_context_store: 1` additionally advertises startup binding with
`--directory PATH [--workspace-id ID]`. The directory is canonicalized and must
exist; explicit workspace identity is isolated from omitted implicit-local
placement. Invalid bindings fail before opening the database. The project-only
entry point remains compatible and refuses context requests without a binding.
Additional methods use the same frame validation and timeout behavior:

- `context_snapshot`: project snapshot plus canonical `directory`, nullable
  `workspace_id`, directory `revision`, nullable directory migration receipt,
  and active native `patterns`, all in one read transaction.
- `context_put {rule}`: directory-only standing allow, returning that snapshot.
- `context_remove {id}`: revoke only in the bound directory and workspace identity.
- `context_migrate {patterns}`: explicit one-time handoff of native directory
  patterns, retaining their IDs and timestamps. Changed inputs fail; exact retry
  does not resurrect revoked patterns.

Per-frame requests cannot change any binding. The combined project/directory
budget counts unique rule content; directory rules never become project grants.
This API does not freeze the old source or activate automatic product migration.

`permission_project_handoff: 1` advertises `handoff {authority,rules}` on the
project control endpoint. The expected durable authority identity is checked
inside the same write transaction before importing rules **or accepting an
existing receipt retry**. A mismatching destination fails without modifying
rules, receipt or revision. Hosts freezing a source must use this method instead
of unbound `migrate`, and probe support before preparing the source. A database
pathname alone is not a durable destination identity.

`permission_context_handoff: 1` similarly advertises
`context_handoff {authority,patterns}` on a directory-bound controller. It checks
the expected project database identity inside the directory write transaction,
before the first import and before accepting a receipt retry. IDs, timestamps,
revocations and the combined rule budget follow `context_migrate`. A mismatched
identity changes neither directory nor project state. The request cannot change
the startup project, canonical directory or workspace identity. Frozen directory
sources must use this method and probe its capability before preparing a handoff;
this destination operation does not itself freeze or retire their old writer.
## Saved-allowance snapshot capability

`saved_rules_snapshot: 1` in `--capabilities` advertises
`permission_saved_snapshot`. The command atomically replaces the workspace's
complete projected saved-allowance set; `rules: []` revokes the last saved rule.
Rules must be bounded allow rules. Invalid input or a failed insert leaves the
previous snapshot intact. The workspace must resolve to the attached Runtime's
own directory. Exact persistent approval grants remain separate.

`permission_saved_project` retains legacy additive-import behavior and cannot
represent revocation. Managed product owners use the snapshot command before
admission, including for an empty set, and fail startup/admission if the engine
cannot synchronize it. This command does not transfer native rule-writing
ownership or remove the compatibility TypeScript permission evaluator.

Local `cancel` and matching `cancel_if` withdraw the Session's product bridge
sources before acknowledging acceptance. Withdrawal serializes with the same
bridge lock held through a permission commit: an already-entered commit may
finish before the acknowledgement, but cannot finish after it. Stale conditional
interrupts leave the current run's sources intact. Cancellation notices to the
host are delivered separately so output backpressure does not delay this fence;
their tasks remain owned by the Session actor. Detach waits for pending notices,
while global shutdown can abort their delivery. A foreign owner's durable
`run.cancel_requested` remains an advisory request for that owner to consume.

### Permission source execution claim

Session-store schema 22 persists `engine_run.lease_epoch` when a fenced run
starts, in the same transaction as the run and any first input promotions.
Permission evaluation, admission and replies require the dispatched tool and
running run to retain that exact Session epoch and the current process owner.
Renewing the same epoch preserves authority; a superseding claim invalidates the
old source even before its asynchronous drain notices the loss. The saved-rule
write and reply remain in the guarded transaction.

Historical and deliberately unfenced storage rows keep a NULL epoch during
upgrade; current lease data is never used to fabricate old execution provenance.
Such rows cannot act as live permission sources. This does not resume provider
work or create another Session/drain identity. Older Session-store writers refuse
schema 22; the separate project permission database retains its own schema version.

Format publication and schema changes share an immediate SQLite transaction.
Upgrading an older store is refused while a recorded running-run owner process
is alive; its schema, format and rows remain available to that older owner.
Finished runs and dead owners do not require provider recovery to upgrade.

### Host default-agent capture

The `session_agent_defaults: 1` capability advertises `serve`/`acp` startup
`--agent-config PATH`, a trusted-host `AgentManifest` JSON file bounded to 4 MiB.
The manifest is validated before background execution is armed. It supplies
default data for Sessions without a recorded agent; it never overrides an
existing explicit selection. A product TUI must refuse a kernel without this
capability rather than silently lose its configured ordered permission rules.

Input admission and the first default-agent selection commit in one transaction,
including admit-only calls. Selection failure rolls back the input. Exact input
retries do not append another selection. Older admitted inputs drained by a wake
or explicit resume capture a still-missing default before constructing provider
policy. The native Session ledger and policy remain authoritative; the host
resolves manifest data and does not decide tool permissions. Standalone callers
that omit the option retain their existing entry policy.

### Legacy Session permission storage names

Session schema 23 renames the projected and native-owned standing-rule tables
to `engine_permission_rule_legacy` and `engine_owned_permission_rule_legacy`.
The rename shares the schema publication transaction and preserves rules,
original identities/timestamps, receipts, revocation state, journals and cursors.
Already-open old SQL readers lose their old table names; older kernels refuse
the new format on reopen. Live older run owners still block a format upgrade.

Current read-only catalogs can inspect older schemas without upgrading them.
A schema-23 reader never falls back to old, missing or ambiguous table names.
This format boundary does not itself freeze a directory or activate shared
Runtime authorization; the separate ownership handshake is described below.

### Explicit directory source retirement

`permission_source_handoff: 1` advertises a separate model-free entry point:
`miao-engine permission-source --db PATH --project ID --directory PATH`. It
requires an existing native Session database and canonicalizes the directory
before opening it. The implicit-local placement and project stay bound for the
process lifetime. Provider flags, credentials and model execution are absent.

- `binding`: startup-bound project, canonical directory and implicit-local workspace identity.
  Hosts compare both controls before freezing a source; this read does not prepare it.
- `snapshot`: nullable immutable source record, including target identity,
  original native patterns, destination fingerprint and `prepared/completed` state.
- `prepare {authority}`: require a quiescent directory with no live or unknown
  run owner, retain its exact pattern IDs/timestamps and freeze its old authority
  in one source transaction. An exact retry adopts that record; changing its
  destination fails. There is no abort/unfreeze operation.
- `complete {snapshot}`: verify the actual destination Context snapshot's
  authority, project, directory, workspace identity, migration fingerprint and
  original imported count. The active destination pattern list may already have
  revocations. A lost destination response or source acknowledgement leaves a
  durable prepared record; retries cannot resurrect revoked rules.
- `shutdown`: flush the acknowledgement and close the source store.

Preparation refuses old rule reads, projection/import APIs, mutation and change
feeds. SQL triggers protect both rule tables and immutable handoff facts against
old writers, including moves between scopes. New legacy model runs in that
directory are refused; durable prompt admission remains separate, and failed run
start rolls promotion back without a provider request. Other directory scopes
remain available. Successful completion retains the freeze until shared Runtime
ownership is configured; this control does not enable that backend automatically.

### Shared permission changefeed

`permission_changefeed: 1` adds `observe`, `changes {after:{authority,seq},limit}`,
`context_observe`, and `context_changes` to model-free permission control.
`observe` returns `{snapshot,cursor}` in one read transaction. Changes contain
only standing-rule invalidations: `{seq,scope,revision,recorded_at_ms}`, with a
`project` scope or a `directory` scope naming its canonical directory and
optional explicit workspace identity. Consumers reload the corresponding
snapshot; a journal invalidation is not a permission grant.

The separate MIAP authority schema v3 appends invalidations through revision
triggers, including writes by already-open v2 connections. Rule, handoff receipt,
revision, and invalidation commit or roll back together. Updates and deletes of
journal rows are refused. Upgrading preserves the Root UUID, rules, revisions,
and receipts; older history is represented by the initial observation rather
than synthesized journal events. Existing `snapshot` response shapes stay intact.

Cursors belong to the authority UUID and its own monotonic sequence, never a
Session journal. Replaced-Root, future, unsafe-integer and invalid-page cursors
are rejected; page limits are 1..256. Project controllers see only their bound
project; directory controllers see that project's standing-rule changes plus
only their own directory/workspace changes. A nonfinal page advances through
its last returned change; a final page advances to the captured Root watermark,
including filtered-out changes, without skipping later matching writes.
This does not activate shared Runtime authorization or settle pending requests.

The shared authority's schema-v4 request transaction is currently a Rust library
boundary, not an advertised host RPC capability. Trusted callers bind a project
and canonical implicit-local directory, then use a Runtime-captured source handle
for `Context.admit_request`, `request_status`, `reply_request`, and
`cancel_request`. The Root UUID, context, source database, Runtime owner, run,
and complete reverse-call identity bind retries. Always writes explicit saved
patterns and its request receipt atomically in Root while the attached Session
database remains read-only. A reply also settles existing sibling assertions behind the real bridge-source
lock: reject stays within the Session, while successful always reevaluates only
live matching sources of the same Runtime/context. Foreign Runtime owners must
refresh their own requests. `retire_source_requests` lets the trusted owner cancel
its precisely captured source after it ends, without granting or saving anything.
Runtime finalization calls, subscription wakeups and migration-aware activation
remain unfinished; these methods must not be treated as an activated backend.

`Context.bind_handoff(Store)` creates an opaque `HandoffBinding` by reading the
actual completed native directory source and current Root receipt. Its snapshot
rechecks Root identity, scope, original fingerprint/count and source receipt while
preserving later revocation. This proves only the native directory handoff; it
neither proves the product project handoff nor unfreezes or authorizes execution.

Session schema v24 adds an immutable nullable `engine_run.shared_permission`
marker. Old INSERT statements omit it and remain refused in a frozen directory.
The explicit verified-handoff run-admission method carries Root/context/receipt,
Runtime UUID and PID; SQLite checks the completed source and current lease before
committing inbox promotion and the run. Active shared placement is immutable,
while same-directory input admission remains available. Default Runtime startup
still uses the legacy entry; this storage boundary alone does not activate the
shared rule/approval backend or authorize a provider/tool operation.

Shared authority schema v5 records the actual source database, run, captured lease
epoch and PID in each request and binds them into its source/input hash. Source
metadata is immutable. Reads, replies and sibling settlement validate the captured
epoch, including a same-PID rewrite of both the run and lease. Schema-v4 pending
requests lack a provable durable source: upgrade retains history and cancels them
with `source_metadata_unavailable`, never retries a provider or changes saved
rules. Old request INSERTs without metadata are refused. A corrupt old request
rolls back the entire upgrade, preserving Root identity, rules and rule cursors.

`Context.recover_source_requests(Store, after, limit)` conservatively sweeps a
bounded page (1..256) for that exact database and context. The cursor advances
past live rows. A Root write transaction locks the attached real source read-only
and checks the recorded run/tool/location/epoch/PID and process existence. Live
or uncertain foreign owners stay pending; inactive sources are only cancelled or
expired. Receipts/events commit together or the page rolls back. No Session
history/run, standing rule, provider or execution is changed. Runtime startup and
finalization still need to call this library boundary explicitly.

The shared request journal has a typed `permission_requests` cursor, distinct
from standing-rule cursors. Pages validate Root identity/watermark and filter the
actual source database plus bound project/directory. Session schema25 stores the
projection event digest and scoped cursor atomically with Session UI events, so
replay, races and restart do not duplicate notifications; a failed page rolls back.
Initial policy-final admission emits no fake UI reply. Pending requests released
by saved rules retain `saved_rules_allowed` and the existing always settlement
vocabulary. Notifications never authorize execution: host assertions still poll
live fenced status. Shared Runtime selection is described below.

### Explicit shared Runtime selection

`shared_permission_runtime: 1` supports `serve`/`acp` selection with both
`--permission-root-db PATH --permission-project ID`. The Root database must
already exist outside the model workspace. The Source directory handoff must be
completed and match the actual Root/project/directory receipt, and the project
handoff receipt must exist. Missing, prepared or mismatched receipts fail startup;
there is no legacy fallback. Shared selection cannot use a fresh diagnostic tool
replay database. Legacy constructors and invocations remain unchanged.

The actual Runtime UUID, PID and captured Session lease bind shared runs. Even a
configured native allow checks this identity; current Root standing rules and
identity namespace the Source-owned exact invocation cache. Host assertions use
the Root transactions and Source fences described above. Local cancellation
withdraws bridge authority and retires pending Root requests before acknowledging;
tool/run completion retires unanswered assertions. UI projection consumes events
for removed executions without recreating deleted history, including reused
Session IDs. Notifications never grant authority.

`permission_source_initialize: 1` adds the explicit model-free command
`permission-source-init --db PATH --project ID --directory PATH`. It validates the
directory before opening or creating the Source database and creates no Session,
provider or background execution. The existing `permission-source` command still
requires an existing file. Both commands expose the same source control methods.
A trusted host completes the project and directory handoffs before selecting the
shared Runtime; these capabilities do not enable automatic product migration.

The shared snapshot/change commands use Root-bound cursors, not legacy Source
journal sequence numbers. Legacy saved-rule projection remains refused after
handoff. A timed-out read does not terminate an unrelated active Session, while
mutations retain the existing fail-closed timeout behavior.

### Managed product migration preview

For the managed native server, `MIAO_SHARED_PERMISSIONS=1` requests the paired
project/directory migration before starting an owner. The Root is the persistent
Core database path with `.permissions.db` appended, preserving channel isolation.
The host verifies exact capabilities and canonical Root placement outside the
workspace, initializes the Source without model execution, then completes the
directory handoff before freezing Core project rules. An active legacy native
run therefore blocks migration before Core freezes. Interrupted handoffs remain
frozen and retryable; they never fall back to legacy authority.

A persisted project handoff selects shared ownership on subsequent starts even
when the preview flag is removed. Shared HTTP saved-rule views use Root records,
preserve imported legacy IDs, and route revocation to Root without reading frozen
Core rules or projecting legacy directory patterns. Queries for a migrated
project without its owning native Location fail explicitly. Explicit workspace
placement, an in-memory Core database and manual legacy saved-rule snapshots are
unsupported for this startup path and fail before either source freezes.

The product's Rust TUI engine shim uses the same paired preparation and persisted
ownership check before launching its engine. A failed product plan exits without
starting an engine from the original raw arguments. POSIX uses an executable
wrapper; Windows passes the product executable and a literal argument prefix to
the Rust launcher. `MIAO_ENGINE_LAUNCH_PREFIX` is a JSON array of strings prepended
to the engine arguments without a shell. Malformed input fails startup. This lets
packaged and source invocations reach the same hidden shim without `.cmd` quoting
or bypassing product preparation. Direct invocation of `miao-engine` retains the
explicit flag contract above.

This preview does not enable migration by default. Shared changefeed supervision,
legacy TS-session retirement and final product acceptance remain requirements
before default activation.
