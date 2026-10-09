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
| `cancel` | `session_id` | `{accepted:bool}` |
| `events` | `session_id`, `after` | `Event[]` (page ≤ 100) |
| `snapshot` | `session_id` | committed Session snapshot |
| `fork` | `session_id`, `target_session_id`, `message_seq?` | `{target_session_id}` |
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
