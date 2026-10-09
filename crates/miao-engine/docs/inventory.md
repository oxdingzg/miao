# miao-engine M0/M1 inventory

Status of each capability family for the Rust engine, with the evidence that
backs the status. Status vocabulary: `inventory` → `designed` → `implemented` →
`validated` (unit/integration tests on CI) → `merged` (on `main`) →
`published`.

An `implemented` row is backed by code and a test in this crate; `validated`
also requires the engine CI to be green. Live model-quality evaluation is out of
scope for this table and is tracked separately.

| Family | Rust status | Evidence / notes |
|---|---|---|
| Session: durable inbox, exact retry, steer/queue, resume, fork, mode | validated | `src/store.rs`, `src/runtime.rs`; `tests/retry.rs`, `tests/fork.rs`, `tests/modes.rs` |
| Session: compaction, history, recall | validated | `src/state.rs`, `src/history.rs`, `src/recall.rs`; recall bounded scan |
| Coding tools: read/list/glob/grep | validated | `src/tools.rs`, `src/search.rs`; bounded, no symlink escape |
| Coding tools: write/edit/apply_patch | validated | `src/file_mutation.rs`, `src/patch.rs`; conditional SHA-256 writes, BOM/EOL preserved, V4A transaction |
| Permission and approval | validated | `src/permission.rs`, `src/approval.rs`; policy upper bound, first-answer-wins |
| Process: foreground command, background job, shell, PTY | validated | `src/process.rs`, `src/jobs.rs`, `src/tools.rs`; macOS seatbelt / Linux Landlock, job slots; `bash -c` and an optional interactive-terminal-style pty with merged output (`tests/bash.rs`)
| Delegation: subagents, resource limits | inventory | M1 gap |
| LSP core (diagnostics/definition/references) | validated | `src/lsp.rs`, `--lsp-config`; lazy per-extension server, Content-Length JSON-RPC, bounded diagnostics and definition/references tools (`tests/lsp.rs`) |
| Media (inline image attachments) | validated | `src/protocol.rs`, `src/store.rs`; base64 image parts on `admit`, promoted into the user message, encoded by the Anthropic/Chat/Responses/Gemini adapters (`tests/media.rs`) |
| Context: session state, todo, goal | validated | `src/state.rs`, `src/tools.rs` |
| State/tools: question, wakeup, cron | validated | `src/question.rs`, `src/wakeup.rs`, `src/cron.rs` |
| Providers: Anthropic, OpenAI Chat, OpenAI Responses, subscription Responses, Gemini | validated | `src/provider.rs`, `src/openai_chat.rs`, `src/openai_responses.rs`, `src/gemini.rs` |
| Auth: API key + credential store, key/oauth kinds | validated | `src/credential.rs`; OAuth refresh broker planned |
| Extension: MCP client | validated | `src/mcp.rs` |
| Extension: hooks | validated | `src/hooks.rs` |
| Extension: TS compatibility worker | inventory | M3 |
| Wire: stdio adapter, durable cursor subscription, snapshot/export | validated | `src/protocol.rs`, `src/events.rs`, `src/export.rs` |
| Wire: HTTP/ACP adapters | inventory | M2 |
| Observability: doctor, platform/sandbox report | validated | `src/doctor.rs` |
| Delivery: single binary, install/update/preview | inventory | M4 |

## Coverage gates

- **M0b gate**: real streaming tool-use loop, ten deterministic/fault scenarios,
  and a three-platform compile. The three-platform build and test is enforced by
  the `engine` workflow (macOS, Linux and Windows).
- **M1 gate**: 30–50 scenarios, a real small fix, a control lane that is not
  blocked by provider/tool/approval waits, and three-platform unit tests. The
  remaining M1 gap is delegation.

## Measurement boundaries (M0)

- Long-session RSS: report engine and full process tree separately, with platform,
  concurrency and context recorded.
- Headless `serve` ready: state whether cold/warm and whether store/config/auth
  are included; report p50/p95.
- Binary size: state debug symbols, architecture, TLS/static libs and external
  dependencies.
- Cost/context: use provider billed usage including cache and retries.
