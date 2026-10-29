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
| `input_status` | `session_id`, `input_id` | admission receipt (see below) |
| `cancel` | `session_id` | `{accepted:bool}` |
| `archive` | `session_id`, `archived` | `{accepted:true, archived}` |
| `pin` | `session_id`, `pinned` | `{accepted:true, pinned}` |
| `remove` | `session_id` | `{accepted:bool, reason?}` |
| `request_compact` | `session_id` | `{accepted:true, duplicate, pending}` |
| `select_agent` | `session_id`, `agent` | `{agent_hash, changed}` |
| `select_account` | `session_id`, `credential_id` (string or null) | `{binding, account, changed}` |
| `events` | `session_id`, `after` | `Event[]` (page ≤ 100) |
| `snapshot` | `session_id`, `metadata_only?` | committed Session snapshot; metadata-only replies omit `messages` |
| `sessions` | — | `string[]` (Session ids) |
| `config_reload` | — | `{generation, changed, unchanged, unsupported, lsp?, mcp?}` |
| `fork` | `session_id`, `target_session_id`, `message_seq?` | `{target_session_id}` |
| `revert` | `session_id`, `checkpoint` | `{checkpoint, from_seq, reverted}` |
| `unrevert` | `session_id` | `{restored}` |
| `approve` | `session_id`, `response` | `{accepted:true}` |
| `approve_persistent` | `session_id`, `response` (allow only) | `{accepted:true}` |
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
`--mcp-config` for MCP; `--model-routes-config` for the model catalog) and
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
removed server is dropped and started again on next use, so a reload never
spawns a process by itself. The `lsp` object in the reply lists the exact
`changed`, `unchanged` and `removed` server names. A derivation error (invalid
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

The standalone entry has no host to call the command, so it polls the same
sources every two seconds (`mtime` plus size, not an OS watcher) and runs the
same reconcile. A tick that lands while a Session is draining is skipped, so no
turn observes half a change; a failed derivation is reported once and retried
only when a file changes again.

### Injected context

`{"type":"inject","session_id":"...","input_id":"optional-retry-key","text":"...","source":"skill:name"}` commits one `message.synthetic` history fact. The source is a bounded attribution label, not a command or credential. Injection creates no inbox row and does not start a provider turn. The host may request advisory `wake` afterwards; this drains eligible pending inbox work without forcing continuation. Unlike explicit `resume`, `wake` leaves an idle Session with no eligible input idle. An exact retry with the same Session and input identity reconciles; changed text/source conflicts. Forks preserve the synthetic record and original timestamp rather than promoting it as an operator prompt. Text is bounded to 1 MiB.

If injected context arrives between a model tool call and its results, the immutable transcript keeps admission order; provider history defers that context until the tool block closes, preserving required tool-result adjacency.

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
