# miao-engine capability inventory

Goals, remaining work and priorities are maintained in the unified
[roadmap](roadmap.md). This inventory tracks implementation contracts, not proven
task-quality, token or latency improvements.

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
| Session: revert/rewind (and unrevert) | validated | `src/store.rs`, `src/history.rs`; soft-revert of the visible projection to a user-message checkpoint, compaction at or after the boundary dropped, append-only ledger, `unrevert` restores (`tests/revert.rs`) |
| Coding tools: read/list/glob/grep | validated | `src/tools.rs`, `src/search.rs`; bounded, no symlink escape |
| Coding tools: write/edit/apply_patch | validated | `src/file_mutation.rs`, `src/patch.rs`; conditional SHA-256 writes, BOM/EOL preserved, V4A transaction |
| Permission and approval | validated | `src/permission.rs`, `src/approval.rs`; policy upper bound, first-answer-wins |
| Process: foreground command, background job, shell, PTY | validated | `src/process.rs`, `src/jobs.rs`, `src/tools.rs`; macOS seatbelt / Linux Landlock / Windows AppContainer (via `miao-sandbox`), job slots; `bash -c` and an optional interactive-terminal-style pty with merged output (`tests/bash.rs`); Windows confinement and output capture (`tests/process_windows.rs`)
| Delegation: subagents, resource limits | validated | `src/runtime.rs`, `src/subagent.rs`; a `task` tool delegates to a child Session with lineage, a depth limit and a global concurrency permit, independent cancellation, and an inherited workspace/policy (`tests/subagent.rs`) |
| LSP core (diagnostics/definition/references) | validated | `src/lsp.rs`, `--lsp-config`; lazy per-extension server, Content-Length JSON-RPC, bounded diagnostics and definition/references tools (`tests/lsp.rs`) |
| Media (inline image attachments) | validated | `src/protocol.rs`, `src/store.rs`; base64 image parts on `admit`, promoted into the user message, encoded by the Anthropic/Chat/Responses/Gemini adapters (`tests/media.rs`) |
| Context: session state, todo, goal | validated | `src/state.rs`, `src/tools.rs` |
| Context: project skills | validated | `src/context.rs`, `--skills-config`; discovers root `*.md` and nested `SKILL.md`, lists name/description in the system context (body read on demand), bounded and symlink-safe (`tests/skills.rs`) |
| Context: host references (read-only roots) | validated | `src/context.rs`, `src/tools.rs`, `--references-config`; lists host-authorized reference paths in the system context and extends `read_file` to those roots as read-only (writes stay workspace-only); the resource is namespaced `@reference/<path>` so the permission boundary does not reject it (`tests/references.rs`) |
| State/tools: question, wakeup, cron | validated | `src/question.rs`, `src/wakeup.rs`, `src/cron.rs` |
| Providers: Anthropic, OpenAI Chat, OpenAI Responses, subscription Responses, Gemini | validated | `src/provider.rs`, `src/openai_chat.rs`, `src/openai_responses.rs`, `src/gemini.rs` |
| Auth: API key + credential store, key/oauth kinds | validated | `src/credential.rs`; OAuth refresh broker planned |
| Extension: MCP client | validated | `src/mcp.rs` |
| Extension: hooks | validated | `src/hooks.rs` |
| Extension: TS compatibility worker | validated | `src/worker.rs`; ADR-12 newline-JSON protocol (hello handshake, `tool.list`/`tool.call`/`shutdown`), External authority, bounded and cancellable, degrades alone (`tests/worker.rs`) |
| Wire: stdio adapter, durable cursor subscription, snapshot/export | validated | `src/protocol.rs`, `src/events.rs`, `src/export.rs` |
| Wire: HTTP/ACP adapters | validated | `src/acp.rs`, `src/http.rs`, `src/host.rs`: ACP stdio and loopback HTTP adapters over one command table, with revision negotiation and resync (`tests/acp.rs`, `tests/http_sse.rs`, `tests/http_transport.rs`) |
| Observability: doctor, platform/sandbox report | validated | `src/doctor.rs` |
| Observability: per-run usage aggregation | validated | `src/store.rs`; `run.usage` sums numeric usage leaves across a run's attempts (including nested `*_details`); per-step `usage` events stay for audit (`tests/run_usage.rs`) |
| Delivery: engine artifacts, manifest and local install | partial | M4a artifacts + release manifest (`engine.yml`) and M4b `script/install-engine.sh` landed; the product entry/preview channel per ADR-08 remains |

## Coverage gates

| Gate | Status |
|---|---|
| M0a | Met: inventory + ADRs 0001–0012 + baseline/measurements. |
| M0b | Met: durable inbox/events/projection, exact retry, coordinator, providers, tools, stdio adapter; ten fault scenarios and a three-platform build+test (`engine` workflow). |
| M1 | Met: coding tools + bash/PTY/job, LSP core, media, subagents, output governance; three-platform unit tests. Shared-primitive parity runs in `native.yml` (Rust matchers vs the TS reference: sandbox-policy, bash-sandbox, edit-native, patch-native, git-status-native), with `miao-sandbox` built by both consumers. |
| M2 | Engine side met: context/revert/fork/compaction/skills/references plus rewind/recovery/fork fault scenarios (`tests/session_rewind_faults.rs`). Remaining: client compatibility — a TS TUI/HTTP/ACP endpoint attaching the engine and one client attaching two engines — owned by the TS-side integration. |
| M3 | Met: providers, role routing + safe fallback (`tests/routing.rs`), and the ADR-12 extension worker (`src/worker.rs`). Credential refresh ownership decided (ADR-09: product-owned during the sidecar phase; the engine stays read-only). |
| M4 | Partly met: Windows AppContainer enforcement, doctor, and delivery artifacts/install landed; a release manifest job produces per-platform checksums. Remaining before the gated default switch: full capability review, live-eval comparison against the baseline, and a rollback drill. |

## Measurement boundaries (M0)

- Long-session RSS: report engine and full process tree separately, with platform,
  concurrency and context recorded.
- Headless `serve` ready: state whether cold/warm and whether store/config/auth
  are included; report p50/p95.
- Binary size: state debug symbols, architecture, TLS/static libs and external
  dependencies.
- Cost/context: use provider billed usage including cache and retries.
