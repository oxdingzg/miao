# miao-engine (experimental Rust engine)

<p align="center"><a href="README.md">English</a> | <a href="README.zh.md">简体中文</a></p>

A standalone entry point that uses its own, explicitly specified SQLite database. The current
implementation provides a durable inbox, transactional event/message projection, supervised Session
execution, streaming adapters for Anthropic Messages / OpenAI Chat / OpenAI Responses, contained
`read_file` / `list_files`, approval-gated `write_file` / `edit_file`, and stdio plus committed
JSONL export. The objective is higher task quality with fewer tokens and less end-to-end time.
Current progress, remaining work and acceptance gates live in the unified [roadmap](docs/roadmap.md)
(中文), with implementation evidence in [inventory](docs/inventory.md). Product integration and the
default switch remain incomplete. Detailed instructions below include early implementation snapshots;
they are not the current capability-gap checklist.

## Running

Build on a build host:

```sh
cargo build --manifest-path crates/miao-engine/Cargo.toml
./crates/miao-engine/target/debug/miao-engine --version
./crates/miao-engine/target/debug/miao-engine serve \
  --db ./engine-local.db --workspace ./example --model YOUR_MODEL
```

`serve` selects Anthropic by default, reads `ANTHROPIC_API_KEY`, and uses the endpoint
`https://api.anthropic.com/v1/messages`. Use `--provider openai-chat` to read `OPENAI_API_KEY` with
the endpoint `https://api.openai.com/v1/chat/completions`; use `--provider openai-responses` to also
read `OPENAI_API_KEY` with the default endpoint `https://api.openai.com/v1/responses`. Public API
profiles accept a key credential; subscription profiles use the existing OAuth snapshot and account
routing through subscription-responses. Standalone login/refresh is not implemented yet, and the
existing broker remains the sole refresh writer. `--endpoint URL` explicitly selects a compatible
endpoint. A provider stream has no authority to configure its own Session, tools, or database. The
version reads the root `package.json`; the crate-internal version is not used as the product version.

Use `--http 127.0.0.1:PORT` to enable the loopback HTTP control plane, reusing the same method table
(`POST /rpc` and the `GET /events` SSE event stream, revision `engine-http-0`); authentication uses a
bearer token taken from `--http-token` or `MIAO_ENGINE_HTTP_TOKEN`, generated at startup and printed
to stderr when absent. Non-loopback addresses are rejected, and TLS is left to a local reverse proxy.

`acp` mode provides ACP (newline-delimited JSON-RPC 2.0) on stdio for editors to integrate directly:
`miao-engine acp --db PATH --workspace PATH --model MODEL [--provider ...] [--endpoint URL]
[--policy PATH]`. The current implementation covers
`initialize`/`authenticate`/`session/new`/`session/prompt`/`session/cancel`, mapping engine
approvals onto a `session/request_permission` round-trip, streaming committed tool calls as
`tool_call`/`tool_call_update`, supporting
`session/load` (history replay)/`session/fork`/`session/resume`/`session/close`/`session/set_mode`,
streaming committed todos as `plan`, and supporting `session/list`; config/usage updates are a later
slice.

Local install (without touching the release-managed `miao` and `miao-preview`): compile on a build
host, then `./script/install-engine.sh --binary /path/to/miao-engine`. It installs to
`~/.local/bin/miao-engine` (versioned under `~/.local/share/miao-engine/bin`), keeps one previous
version for one-step rollback, and smoke-tests `--version`.

## stdio protocol v0

One JSON object per line. A request carries a string or number `id`; the response carries the same
`id` with either `result` or `error`. Notifications carry no request id. The current surface supports
local stdio, the loopback HTTP control plane (including the SSE event stream), and the ACP stdio
adapter (core session lifecycle, see PROTOCOL.md); it does not claim compatibility with the existing
miao HttpApi.

```jsonl
{"id":1,"method":"subscribe","params":{"session_id":"s","after":0}}
{"id":2,"method":"admit","params":{"input":{"session_id":"s","input_id":"p1","prompt":"Read README.md and summarize it","delivery":"steer"},"resume":true}}
{"id":3,"method":"events","params":{"session_id":"s","after":0}}
{"id":4,"method":"cancel","params":{"session_id":"s"}}
{"id":5,"method":"shutdown"}
```

Other methods: `resume` (explicitly start continuation of an existing history), `unsubscribe` (stop
notifications for a given Session). `admit.resume=false` is durable admission only. A `cancel` ack
means cancellation was accepted; the actual stop is recorded by `run.finished`. `events` returns at
most 100 per page; page on with the last `seq`.

- An `event` notification is a canonical event already committed in SQLite and carries the Session and cursor.
- A `progress` notification is an ephemeral provider frame and is not guaranteed to survive a crash; once the full message is committed it can be rebuilt from `events`.
- A slow progress consumer may receive `resync`; when the stdio output queue fills the connection is terminated, and the committed events are read after a restart/reconnect.
- A subscription polls the durable cursor and does not rely on transient notifications for the replay→live handoff, so there is no dual-source handoff window that drops events.

## SQLite and JSONL

SQLite WAL/FULL is the sole durable authority. The inbox, canonical events, message projections,
execution records, and tool dispatch/settlement state are written on a dedicated SQLite worker; the
control executor performs no blocking SQLite IO. The OS lease is held by the same worker; a second
runtime on the same path cannot start. A separate engine application ID/schema version prevents
misuse of the existing miao database or an unsupported future schema.

JSONL is exported from a committed snapshot, needs no provider key, and can be read in parallel with
an active runtime:

```sh
./crates/miao-engine/target/debug/miao-engine export \
  --db ./engine-local.db --session s --after 0 > session.jsonl
```

export does not create a missing database, does not change execution state, and does not take on a
second authoritative log. The read transaction pins a high-water mark; a very slow external export
prolongs SQLite snapshot/WAL retention, so long-term analysis should read from the exported file.

## Execution invariants

- The same input id retries exactly and fully by Session, prompt, and delivery; a conflict produces no extra admission.
- A pending exact retry can repair a lost advisory wake; a promoted exact retry does not replay provider work.
- Steers are promoted in a batch at a safe provider-turn boundary; a queued input is promoted one at a time only when execution would otherwise become idle; new input resets the turn allowance.
- Execution is serial within a Session and parallel across Sessions; the M0 ceiling is 64 attached Sessions, 8 active executions, and a 25-provider-turn allowance per input.
- The actor control loop can respond to cancel while waiting on the provider; tasks are cancelled and joined on shutdown.
- When the same tool name/input/result accumulates 3 times with no new user input, `loop.detected` is recorded and the run stops; new input resets the count. This detection does not claim to identify every semantic loop.
- A provider panic reconciles only the current Session; a slow ephemeral progress consumer does not block execution, and other Sessions are unaffected by that failure.
- The full assistant/tool-call projection and planned intents share one transaction; dispatched is recorded only after authorization passes; tool settlement and the tool-result projection share one transaction.
- Location is bound in the same transaction as admission, so a Session never migrates silently when the startup workspace changes.
- A pending approval binds Session/run/call, Location, resource, the full input hash, the policy revision, and a deadline; only the local stdio controller may answer.
- An approval wait does not occupy the control loop, and a late answer after cancel is ignored; an undispatched tool recovers as not_executed, and only a dispatched call with an unknown result is marked unknown.
- Startup does not auto-continue; an unsettled dispatch is marked unknown, a repair tool-result error fixes the history, and the external operation is not redone.
- Pre-response transport errors/429/specific 5xx errors retry up to 3 times within a 60-second total budget; after the 200 body starts there is no opaque replay.
- Provider SSE supports bytewise UTF-8, CRLF, and multi-line data; frame limit 1 MiB, message limit 8 MiB.
- Truncated tool JSON, a missing terminal, unknown hosted/thinking blocks, and an unsupported finish reason all fail explicitly and do not dispatch an incomplete tool.
- Responses settles on the complete output of `response.completed` and preserves the encrypted reasoning item verbatim; opaque blocks are only echoed to the same protocol/model, and a cross-protocol or cross-model reuse is rejected explicitly rather than silently dropped.

## Verification

```sh
cargo fmt --manifest-path crates/miao-engine/Cargo.toml --check
cargo test --manifest-path crates/miao-engine/Cargo.toml
cargo clippy --manifest-path crates/miao-engine/Cargo.toml --all-targets -- -D warnings
```

The tests cover a real local HTTP fixture→runtime→file-tool→next-model-turn closed loop for all
three protocols, Chat usage/DONE/tool-argument chunking and rejection handling, the real local HTTP
fixture adapter, no retry after a 200 stream cut, tool-argument truncation, capacity retry, workspace
escape/oversized files, exact retry/lost wake, cancel/across-Session, unknown recovery, atomic
settlement, stdio requests, and the read-only export high-water mark. The tests consume no live
provider credentials; passing fixtures is not claimed as real-model quality acceptance.

## Current progress and remaining work

The [roadmap](docs/roadmap.md) maintains implementation, task-efficiency and product-integration
status in one place. PTY, background jobs, Windows enforcement, Gemini, LSP core, image input,
Context Epoch, explicit compaction, MCP, the worker protocol host and three-platform tests already
have implementations. Automatic context management, representative efficiency evaluation, the
complete product facade, actual extension integration and shipping delivery still have gaps.

The following describes the early file-tool slice; see inventory and source for the current tool
surface. `read_file` is a read-only tool with canonical
containment, up to 32 KiB of UTF-8; `list_files` lists only immediate children, up to 500, without
recursion or following child symlinks; it does not claim resistance to malicious concurrent path
replacement inside the workspace. Default read_only exposes no write tools; workspace mode exposes
write_file/edit_file with per-call approval by default, or explicit allow/deny path rules. After
`allow_process` is explicitly enabled, foreground sandboxed processes are available, and their
database must live outside the workspace.

## Permission configuration and conditional file commit

`serve --policy PATH` reads an in-budget JSON configuration; the mode/rules/approval timeout form a
policy revision. The default is read_only. Workspace writes default to ask, and a tool does not skip
leaf permission merely because it appears in the catalog.

```json
{"mode":"workspace","approval_timeout_ms":60000,"rules":[{"tool":"write_file","path":"generated/**","decision":"allow"},{"tool":"*","path":"secrets/**","decision":"deny"}]}
```

After receiving `approval.requested`, reply with its input_hash/policy_revision through the local
stdio `approve` method; the response decision can only be allow/deny and cannot submit a
self-claimed controller role. The controller capability is held by the adapter.

```jsonl
{"id":10,"method":"approve","params":{"session_id":"s","response":{"request_id":"REQUEST_ID","input_hash":"INPUT_HASH","policy_revision":"POLICY_REVISION","decision":"allow"}}}
```

- read_file returns text and sha256; write_file requires that fingerprint for an existing file, and expected_sha256=null only creates a file that does not exist.
- edit_file requires the fingerprint and performs exact matching; an ambiguity needs replace_all=true. It does not rewrite BOM/line endings and preserves existing permissions.
- File content/result is at most 32 KiB; parent directories are not created automatically, and writes do not go through a final symlink.
- File publication goes through a cap-std directory capability, publishing after an fsync of the staging file, and creation uses atomic no-clobber.
- In the current registry, writes are serial and reads are shared; the fingerprint re-check of an existing file against other runtimes/non-cooperating external writers is an optimistic check and does not claim a general atomic CAS.
- A file commit that has started must join/settle and is not discarded by cancel; external side effects before and after a failure/cancel are still reconciled against the durable dispatch/settlement.
- Unix syncs the parent directory; Windows file/directory durability and the whole platform run still need dedicated acceptance.

## Foreground processes and sandbox

run_command is exposed only when `mode=workspace` and `allow_process=true` are configured; the
default is ask. `process_network=false` disables network by default, and the model cannot raise its
own privilege through tool arguments. The mode/capabilities/rules form the same policy revision.

```json
{"mode":"workspace","allow_process":true,"process_network":false,"rules":[]}
```

run_command accepts an explicit argv, a workspace-internal cwd, and a 1..120000ms timeout; there is
no implicit shell. stdout/stderr are at most 32 KiB each, and exceeding the limit stops the process.
Timeout/cancel reaps the ordinary process group and joins/reaps the pipe readers, recording the
termination reason. Foreground tools do not claim to support a malicious daemon lifecycle that
escapes the process group; background tasks/cgroup/Job ownership come later.

- macOS: a seatbelt workspace-write profile; paths are escaped as strings and cannot inject policy syntax; the network policy restricts communication rather than requiring socket object creation to fail.
- Linux: a fresh runner applies the full Landlock ABI v3 filesystem rights before Tokio initializes; when the network is disabled it attaches an inherited seccomp socket filter.
- It fails when enforcement is unsupported or cannot be applied, and does not fall back to a bare process. Windows does not expose this capability today.
- Both currently allow global reads; workspace-write is not secret-read isolation. macOS permits writes to the system temp/dev, while Linux permits only workspace/job temp and /dev/null; the difference is described by the actual profile.
- The launcher clears the environment and passes only PATH/HOME/locale/TERM and the job temp, and does not pass provider keys to the subcommand.
- When processes are enabled, the authority DB is forced outside the workspace; the file tools also protect the DB/WAL/SHM/lease paths.
- If the parent-directory sync fails after the file is published, it returns an applied result with applied=true and durability=unknown; it does not disguise this as a side-effect-free failure.

Verification status: macOS arm64 and Linux x86_64 pass 127 engine tests and 6 sandbox tests, strict
clippy, and fmt. A real stdio→HTTP fixture→sandbox command verified argv execution, provider key
isolation, and durable settlement; not live-model quality acceptance.

## Session snapshot, fork, and Context Epoch

```jsonl
{"id":20,"method":"snapshot","params":{"session_id":"s"}}
{"id":21,"method":"fork","params":{"session_id":"s","target_session_id":"branch"}}
{"id":22,"method":"context","params":{"session_id":"s","epoch":1}}
```

snapshot returns, in one transaction, the committed cursor, Location, messages (with seq), pending
previews, active_run, pending approvals, and current context metadata. The projection limit is 1000
entries/2 MiB and the total snapshot is 4 MiB; exceeding it fails explicitly and you can page with
`events`, rather than silently dropping history.

fork reconciles an exact retry using target_session_id. An active parent requires an explicit
message_seq and cannot pick an unresolved tool-call boundary. It copies only the closed conversation
prefix, Location, and the corresponding Context Epoch; it does not copy the inbox, approvals, tasks,
external side effects, or files, and does not auto-wake. A fork currently shares the same Location
filesystem; it is not an independent worktree and offers no file rollback.

Each provider-turn boundary assembles a stable baseline plus the workspace AGENTS.md. Automatic
loading honors the read policy, the workspace/protected-resource boundary, and size limits; a source
marked ask/deny never enters the system unauthorized. A Context Epoch stores the exact system, source
metadata, and fingerprint; it does not treat a mutable file path as historical content. If content
and sources are unchanged the epoch is reused; on change an immutable epoch is appended and
`provider.started` links to it; a fork inherits the epoch at its message checkpoint. The system does
not embed volatile Session/run IDs, and the three adapters each map it to their native
system/instructions input. Only the workspace producer is implemented today; ancestor/user
instructions, skills/references/persona, full context selection, and compaction remain to be wired
in.

## Read-only credential compatibility and subscription profile

```sh
miao-engine credentials --credential-db /path/to/miao.db
miao-engine credentials --auth-file /path/to/auth.json
miao-engine serve --db /path/to/engine.db --workspace /path/to/project --model MODEL \
  --provider subscription-responses --credential-db /path/to/miao.db \
  --credential-id cred_ID --credential-integration openai
```

- discovery outputs only id/integration/label/kind/expiry and does not serialize token, refresh, or account fields.
- The source read-only parses the existing credential table or legacy auth.json; it does not create a missing database, migrate, or write back.
- An explicit credential-id must also match the integration; a protocol-compatible service can bind explicitly with credential-integration; it does not guess credentials across providers.
- Each provider turn re-reads the source and can follow the existing broker's token rotation; an expired snapshot fails explicitly and does not compete to refresh.
- The default environment-variable source remains available; the subscription profile uses OPENAI_ACCESS_TOKEN and an optional OPENAI_ACCOUNT_ID.
- When the API-key/OAuth type is incompatible with the selected profile, it is rejected before the request is sent; redirects are disabled so the token is not sent to a redirect target.
- The credential file/DB is excluded from leaf tools and automatic context as a protected resource; when processes are enabled the source must be outside the workspace.
- workspace-write does not provide global secret-read isolation; an explicitly approved arbitrary process still has the read capability described by the profile.
- The current read-only bridge is not a full credential broker: device login, a standalone refresh/rotation lock, cross-broker migration, and live-account task acceptance remain to be done.

## Durable background jobs

start_job/job_status/cancel_job are exposed only when `mode=workspace, allow_process=true,
allow_background=true`. The full argv/cwd/timeout of start_job still goes through permission and
binding approval; it returns a durable queued job_id, which is not the same as having executed
successfully. Currently each runtime supports at most 32 active/queued jobs and 2 execution slots;
commands still use the foreground size/120s timeout and bounded output.

```jsonl
{"id":30,"method":"jobs","params":{"session_id":"s"}}
{"id":31,"method":"job","params":{"session_id":"s","job_id":"JOB_ID"}}
{"id":32,"method":"cancel_job","params":{"session_id":"s","job_id":"JOB_ID"}}
```

- A turn cancel does not cancel an accepted background job; only job cancel/runtime shutdown controls its lifecycle.
- queued/running/terminal/result are persisted; recovery marks queued as interrupted and running as unknown, and does not auto-rerun.
- A job admission exact retry for the same dispatched tool intent does not create a second task, and the input must match.
- Model job control is bound to the current Session; knowing a UUID does not allow querying/cancelling another Session's task.
- Background is an explicit external writer and does not hold the foreground registry's whole-run file lock; a conditional edit is still an optimistic fingerprint check against it.
- A guardian keeps a private pipe lifeline; a hard engine exit closes it and the ordinary process group is reaped. The user command's stdin remains empty and cannot touch the control pipe.
- A malicious setsid/standalone daemon still needs later cgroup/Job ownership; this is not yet a cross-platform persistent-process hosting service.

## History selection and explicit compaction checkpoint

```jsonl
{"id":40,"method":"history","params":{"session_id":"s","selected":true}}
{"id":41,"method":"compact","params":{"session_id":"s","compaction_id":"CHECKPOINT_ID","through_message_seq":42,"summary":"Summary of completed work, constraints, and follow-up goals."}}
```

compact is an explicit projection operation of the local controller: the Session must be idle, and
the boundary must be a closed, completed assistant message. The same checkpoint id reconciles
Session/cutoff/summary; a conflict fails and never moves backward. Raw messages/events are not
deleted. The provider uses a selected_history of summary+tail while retaining the full uncompressed
tail of opaque/tool records; an oversized window reports an explicit budget error. Verification is
streaming-based, allowing an old prefix that already exceeds the selection budget to be compacted
into a checkpoint; the summary is at most 32 KiB. A default fork inherits the currently effective
checkpoint and maps the message cursor; an explicit history fork inherits only the checkpoint that
already existed at that point. This is not automatic LLM summarization or a task-quality guarantee;
automatic policy, model role routing, and context-quality evaluation remain to be implemented.

## MCP stdio client (explicit external authority)

Specify a host configuration outside the workspace via `--mcp-config
/absolute/path/servers.json`:

```json
[{"name":"local_service","argv":["/absolute/path/to/server","--stdio"],"env":{}}]
```

The permission policy must set `mode: "workspace"` and `allow_mcp: true`. Starting a server is a host
configuration action; an MCP server is a trusted external service with its own filesystem/network
authority, and the `run_command` workspace sandbox does not apply to it. Each tool call still goes
through the existing durable intent and binding approval; the default is ask, and rules can be
configured with the `mcp_*` tool matcher and the `@mcp/local_service/**` resource matcher.
`readOnlyHint` grants no permission.

- The catalog is fixed at initialization: at most 8 servers and 4 pages/128 tools per server; the alias is stable, limited to 64 characters, and includes a fingerprint of the original name.
- The schema is at most 32 KiB and JSON Schema validation completes before authorization and dispatch; the description is at most 4 KiB.
- Initialization/catalog is 15 seconds per request, a call is 60 seconds, the wire frame is 256 KiB, and a returned result is 64 KiB.
- input/task continuation fails explicitly; a disconnect/timeout is not auto-replayed, and it cannot be asserted that no external side effect occurred.
- cancel stops the local wait, and a dispatched call may still be executing on the server; Session recovery follows the unknown intent boundary.
- A normal shutdown closes the transport and kills/reaps the configured direct child process. A hard engine exit and server-derived/daemon processes do not yet have a full cross-process ownership guarantee.

Remote HTTP transport, dynamic catalog notifications, resources/prompts, MCP OAuth, and TS plugin
compatibility are not implemented today.

## Explicit workspace Context Sources

`--context-config /absolute/path/context.json` selects additional instruction/persona files:

```json
[{"label":"persona","path":"docs/persona.md"},{"label":"team-rules","path":"docs/team-rules.md"}]
```

The configuration lives outside the workspace, and content paths must be workspace-relative. At most
16 additional sources; a label uses ASCII letters/digits/`_.-` limited to 64 characters, and a path
cannot have an empty, `.`, or `..` segment. By default `AGENTS.md` loads first, then the sources in
configuration order; each item reuses the scoped `read_file` and file-level policy, an ask/deny item
is not read, and missing/skipped is also recorded in provenance. Each file is at most 32 KiB and the
final system is at most 64 KiB; exceeding the budget fails explicitly. The provider boundary re-reads
and stores, through an immutable Context Epoch, the full system, source hashes, and selection order.

This provides explicitly selected workspace producers; ambient user/ancestor discovery, a full
skill/reference catalog, and per-task automatic selection are not implemented yet.

## In-Session raw-history recall

```jsonl
{"id":50,"method":"recall","params":{"session_id":"s","query":"old error text","limit":10}}
```

The model tool `recall` is automatically bound to the current Session and does not accept a target
Session ID; its permission resource is `@session/history`, reusing the leaf policy and durable tool
intent. The host stdio adapter may select a Session explicitly. A query is a case-sensitive literal
substring (at most 512 UTF-8 bytes); at most 20 matches per page, scanning at most 1000 messages/2
MiB. It is ordered by descending message seq and returns the role, seq, and a UTF-8-safe bounded
preview. When the scan is incomplete it returns `next_before_message_seq`; even when matches is empty
you must use `exhausted` to decide whether history remains. A single message over 2 MiB is not
loaded; it explicitly returns `skipped_oversized_message_seqs` and advances the cursor, while the raw
record is retained. It searches text/tool input/result in raw messages and does not search generated
summaries or opaque provider continuation. A search does not modify the transcript or a checkpoint,
nor does it schedule execution automatically.

## Durable Session state: todos / goal

The `session_state`, `todowrite`, and `goal` model tools are automatically bound to the current
Session; the host adapter provides:

```jsonl
{"id":60,"method":"state","params":{"session_id":"s"}}
{"id":61,"method":"update_state","params":{"session_id":"s","operation_id":"todo-edit-1","tool":"todowrite","input":{"todos":[{"content":"verify the change","status":"in_progress","priority":"high"}],"expected_revision":0}}}
```

The SQLite event ledger is the sole source of state; there is no extra JSON file or second mutable
store. Each update checks `expected_revision` and commits `session.state.updated` within the same
transaction; the revision is the event seq of that commit. `expected_revision: 0` means no such state
exists yet; omitting the revision uses serialized last-write behavior. The same Session/operation id
reconciles kind/value/expected revision, and an exact retry returns the original commit; a conflict
writes no event. A model operation id is bound to run/call; a state revision conflict returns an
explicit tool error and requires re-reading the state.

At most 128 todos, each with non-empty content and at most 2 KiB, and at most 32 KiB total; a goal
objective is at most 8 KiB, evidence at most 8 KiB, and budget at most 2 KiB. done/blocked requires
non-empty evidence; the engine records the claim without independently verifying its truth. State
operations use the SessionState capability, and a filesystem read-only mode can still update its own
todo/goal; rules can explicitly deny with `@session/state/**`. This does not grant filesystem write
or cross-Session authority.

snapshot includes the state at the same cursor; a default fork inherits the current state, and an
explicit history fork inherits only the state before the boundary and generates a target revision.
compaction preserves state; recovery does not replay state tools, and `session_state` can reconcile
the committed values. Each provider boundary selects history and state within the same SQLite read
transaction; when state reading is allowed, the current values are injected as an independent
user-role dynamic prefix. This projection does not write to the raw transcript and does not change
the stable system/Context Epoch; `provider.started.state_selection` records the selected revision and
fingerprint. When the `session_state` read policy is ask/deny, injection is skipped. The history+state
total budget is still 2 MiB; notifications remain to be implemented.

## Durable choice question

The model `question` accepts 1..4 questions, each with 2..4 unique options; it supports `multiSelect`
and a `custom` typed answer enabled by default. The header is at most 12 characters and the full
request/answer is at most 32 KiB each; the timeout defaults to 60 seconds with a maximum of 10
minutes. Query pending requests through `questions` or snapshot, and answer with the
controller-identity-bound `answer_question`:

```jsonl
{"id":70,"method":"questions","params":{"session_id":"s"}}
{"id":71,"method":"answer_question","params":{"session_id":"s","answer":{"question_id":"RUN/CALL","input_hash":"HASH_FROM_REQUEST","answers":[["OPTION_LABEL"]]}}}
```

A request requires an existing active/dispatched `question` intent; it is bound to location/input
hash and Session/run/call, and the answer must satisfy the options, single/multi-select, and custom
rules. The runner reads the result only after the answer is written to the SQLite event ledger; a
fully identical answer retry reconciles, and a different or already-cancelled/expired late answer is
rejected. A normal cancel, shutdown, and recovery close pending requests and do not automatically
re-ask or start the provider. Recovery also cleans up historical orphaned questions, at most 256; a
fork does not inherit pending interactive requests. The model has only the question tool, not the
controller's answer permission; the read policy can deny a request through `@session/question`. The
current adapter outputs structured requests and answers; there is no TUI question UI, option preview,
or remote controller authentication yet.

## Read-only doctor acceptance entry point

```sh
miao-engine doctor
miao-engine doctor --db /path/to/engine.db
```

It needs no provider or credentials and outputs JSON: the compiled version, OS/arch, sandbox
available, the provider transport list, and, for an optional DB, the application id/schema, the
`quick_check(1)` integrity result, Session/event/message counts, and input/run/tool status
statistics. The database is checked with a read-only connection and a single read transaction,
without acquiring the engine owner lease, admitting, or reconciling. A running owner's DB can also be
checked; an unrelated/future/missing DB returns failure, it does not create or migrate a DB, and it
does not output prompt/tool content. The integrity result is at `database.integrity.ok`; doctor is
not network connectivity, credential validity, or task-quality acceptance.

## Process-owned one-shot wakeup

`schedule_wakeup` / `cancel_wakeup` are exposed to the model only when the permission config has
`allow_wakeup: true`; this is an independent capability, default ask, that lets a filesystem
read-only Session schedule later input with explicit authorization. Rules can be configured with
`schedule_wakeup` + `@session/wakeup`, and the cancel resource is `@session/wakeup/TIMER_ID`. The
input `prompt` is at most 8 KiB, `delaySeconds` is 60..3600, and `delivery` defaults to queue but can
be explicitly steer.

```jsonl
{"id":80,"method":"wakeups","params":{"session_id":"s"}}
{"id":81,"method":"cancel_wakeup","params":{"session_id":"s","timer_id":"TIMER_ID"}}
```

At most 8 attached timers per Session and 64 per process; the timer task is supervised and joined by
the Runtime, a turn cancel does not cancel a timer, and an independent cancel_wakeup only closes a
timer that has not fired. On fire, `input.admitted` and `wakeup.resolved(fired)` commit in the same
transaction with the fixed `wakeup/TIMER_ID` input id, and only then is the advisory wake sent; queue
is promoted at the idle boundary and steer at a safe provider boundary.

The SQLite event ledger retains schedule/result metadata; the timer itself uses a process-local
monotonic deadline. shutdown cancels/reaps unfired timers; recovery marks an unfinished schedule as
interrupted and does not reschedule the timer, send a prompt, or rerun the provider. If input has
already been admitted and committed, its admission is retained and handled by the existing
pending/promoted and explicit-resume rules. Fire and cancel serialize on the durable resolution, and
a fired timer cannot withdraw a committed prompt; a fork does not copy timers. snapshot includes the
current unfinished timers, and wakeups provides the status of the most recent 100. Cross-process
timing guarantees are not implemented yet.

## Process-owned recurring cron

`allow_cron: true` independently enables `cron_create` / `cron_list` / `cron_delete`; it is not
granted automatically by `allow_wakeup`. Creation uses the Cron capability, default ask; the rule
resource is `@session/cron` and the delete resource is `@session/cron/ID`. It accepts a numeric
standard five-field expression, supporting `*`, commas, ranges, and steps; it does not accept
seconds/year, nicknames, or extended modifiers. It uses the croner calendar parser, DOM/DOW has the
standard OR semantics, and the system local timezone and DST transitions follow the parser's
behavior.

```jsonl
{"id":90,"method":"crons","params":{"session_id":"s"}}
{"id":91,"method":"cancel_cron","params":{"session_id":"s","cron_id":"ID"}}
```

The model input `prompt` is at most 8 KiB, `cron` at most 256 bytes, `recurring` defaults to true,
and `delivery` defaults to queue. At creation the next occurrence must fall within the seven-day
process-lifetime window; later calendar lookups complete on a separate blocking worker. cron and
one-shot wakeup share the 8/Session, 64/process attached-schedule total limit.

Each occurrence uses the fixed `cron/ID/OCCURRENCE_MS` input id, with admission and `cron.fired`
committed in the same transaction, and a duplicate occurrence does not send input again. When the
same cron already has pending input it records `cron.skipped(prior_input_pending)` rather than piling
up a new prompt. After a pause it looks for the next date from the current logical time instead of
back-filling missed ticks one by one; calendar dates are converted to process-local monotonic
deadlines. recurring=false completes after the first fire; the seven-day expiry closes the schedule,
and an independent delete only stops future occurrences without withdrawing already-admitted input. A
turn cancel keeps a cron, shutdown joins/cancels, recovery marks it interrupted and does not
reschedule, back-fill, or rerun the provider; a fork does not inherit schedules. Structured queries
return the next occurrence, fired/skipped counts, and terminal state, and snapshot includes
unfinished crons.

## Gemini native GenerateContent SSE profile

```sh
GEMINI_API_KEY=... miao-engine serve --db /path/to/engine.db --workspace /path/to/workspace --provider gemini --model MODEL_ID
```

An existing read-only credential source can also be used, with the default integration `google`. It
is currently an API-key profile passed through the sensitive `x-goog-api-key` header and does not
accept an OAuth/subscription profile. The default endpoint is the native
`v1beta/models/MODEL_ID:streamGenerateContent?alt=sse`, and a full compatible endpoint can be
configured explicitly; the model must be specified explicitly.

text/functionCall parts and late usageMetadata go through the common bounded SSE decoder, pre-body
retry, and cancel control. An unregistered `response.*` sequenced checkpoint event that appears
before `response.completed` is skipped rather than rejecting completion of the response; the
completed output array is the sole authority, and an unknown event not prefixed with `response.*`
still fails explicitly. Only a single candidate and a STOP finishReason are accepted; truncation,
blocked/unknown parts, partial/malformed args, and a duplicate wire call id fail explicitly, with no
opaque replay after the 200 body is received. Each reply projection is at most 512 KiB with at most
128 function calls.

function calls use an independent engine tool id; the wire id/name/args and the full native parts are
preserved in a `provider_opaque(gemini-generate-content, model)` capsule. The thoughtSignature keeps
its original value, order, and owning part; the next turn echoes the native model parts and merges
consecutive user functionResponses, preserving wire ids and structured results. A protocol/model
mismatch or a modified native/neutral mapping is rejected before the HTTP request is sent. Foreign
tool history without a native capsule does not synthesize signatures; ordinary unsigned text history
is portable.

Current verification is the native wire/profile/runtime path with a real HTTP fixture; there is no
acceptance with a real Gemini account. Vertex, Interactions, multimodal/hosted tools, streaming
partial-function arguments, and the Google OAuth broker are not implemented yet. Official behavior
reference: [thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures).

## Explicit pre-response fallback

`serve --fallback-model MODEL_ID [--fallback-endpoint URL]` configures a secondary with the same
provider/profile/credential source. `routing::Fallback` can also compose native providers, and their
protected credential resources are merged. With a custom Gemini primary endpoint, the fallback
endpoint must be given explicitly so the new model's URI is chosen by the host.

The whole provider turn shares a three-HTTP-attempt / 60-second pre-response budget: with a
switchable secondary, the primary gets one attempt and the secondary up to two. It switches only on a
transport failure that did not accept a response, or on HTTP 429/500/502/503/504/529; it does not
switch on a response-body transport failure, a truncation/semantic error, or an auth/history problem.
The body idle timeout still follows the existing stream rules.

It reads the opaque protocol/model binding of the projected history: when only the secondary matches
it pins directly to the secondary; when only the primary matches and the secondary is incompatible
it keeps the primary's three-attempt budget; a mixed/unknown binding fails explicitly. It does not
delete or convert signatures/reasoning state, nor request another model after accepting a response.
The budget of each concurrent turn is independent; the resolver holds no Session/store and starts no
separate tool loop.

With this wrapper enabled, `usage` is `{reported: VENDOR_USAGE, routing: SELECTION}`; failure events
also store routing metadata. The selection contains protocol/model, primary/fallback, opaque_pinned,
the fallback reason, and the attempt count, but no endpoint or credentials. There is currently no
full purpose-role catalog, automatic model discovery, or quality/price routing.

## Host lifecycle hooks (around tools)

`--hooks-config /absolute/path/hooks.json` configures host-side hooks (outside the workspace, ≤64
KiB, automatically listed as a protected resource):

```json
[{"event":"tool_before","tool":"run_command","argv":["/path/guard","--check"],"timeout_ms":10000}]
```

`event` is `tool_before` / `tool_after`; `tool` is an exact model tool name or `*`; at most 16,
deduplicated by `(event, tool, argv)`; argv reuses the run_command validation (≤128 segments, no NUL,
timeout 1..120000ms, default 10s).

The hook process goes through the same sandbox path as run_command (workspace write sandbox, network
off, separate temp directory, process-group guarding). `tool_before` runs after policy authorization
and before intent dispatch: it passes only on exit 0 with a normal exit; a nonzero exit, timeout,
output overrun, or execution error is uniformly fail-closed and blocks dispatch, with the tool result
`blocked by tool_before hook (outcome …)` and no tool side effect. `tool_after` runs after the tool
result is durably recorded and only observes, never changing the result or error status. Each
execution records `hook.completed` (phase/tool/outcome/exit_code/reason/duration), which is
auditable.

Hooks are a gatekeeper/observation surface of trusted host configuration, not a model capability:
they do not occupy permission rules, do not need allow_process, and give the model no new authority.
There is currently no per-hook network, stdin injection, run/turn-level event, or remote hook.
