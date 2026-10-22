# Native product acceptance matrix

This is the evidence checklist for switch-plan G3, G4 and G6. Crate tests,
facade tests, real-client acceptance and published-artifact drills are separate
columns of evidence. A passing implementation test does not close a product
gate or authorize the default switch.

## Client lifecycle (G3)

Native Session information exposes `execution: { engine: "rust", selection:
"operator" }`. The TUI admits plain prompts directly for this policy instead
of applying its TypeScript agent/model preferences first. Its footer identifies
the operator-bound native route, and selection actions do not overwrite local
preferences for that Session. Other Session information may omit the field;
legacy TypeScript preference selection then retains its existing behavior.

A real attached full TUI has been exercised with a local deterministic provider:
native history renders, a prompt typed into the TUI reaches the native provider,
and its reply renders. This plain-prompt scenario does not close the remaining
approval, interruption, external-client or capability rows below.

**Resolved 2026-10-16: the native live event stream reaches attached clients.**
The blocker described below was a wiring defect, not a missing bridge. The
client-event fan-out registry lived inside each `ClientEvents` layer instance,
and the native transport is built with `Layer.fresh` once per listener, so the
bridge published product events into an instance that held no subscribers. The
registry is process-scoped now, so publishing and subscribing meet on the
process instead of on the layer; a regression test pins a publish across two
separately built graphs and fails when the registry is instanced again.

Verified in a real attached TUI over the published 0.2.13 engine with a
deterministic provider: the pending approval renders, granting once lets the
engine execute its `write_file` (`tool.completed` with `applied:true`), the tool
block and its result render in the transcript, Esc interrupts a hanging call
without a replacement provider request, and the Session then serves a new
prompt. The rejection path was also verified: Esc rejects the pending approval,
no file is created, the ledger contains no `tool.dispatched`, and the next
provider request carries the rejected tool result.

Message-level usage already flows through the native journal translator and
transcript reducer; `native-history-http.test.ts` verifies those tokens against
the published engine. The missing Session GET lifetime token totals are now
read from the existing engine usage report (#911), with two-turn/cache-read
aggregation covered by the same HTTP acceptance test and no shadow TS history.
Creation/listing keep their inexpensive defaults. Pricing and product
per-model usage summaries remain separate work; the full cache/TTFT presentation
matrix is not closed by a successful cumulative token assertion.

The independent ACP SDK acceptance in #912 covers allow/reject, cancellation
and continuation, and process replacement/resume over the executable's stdio
entry point. This proves a separate protocol consumer, not integration inside
a third-party editor UI. That UI integration and real-client backlog bounds
remain open.

<details>
<summary>Original observation (2026-10-16, before the fix)</summary>

**Open blocker (found 2026-10-16; diagnosis corrected the same day): a native
Session publishes no live session events.** An attached client cannot follow or
approve a native turn, because the serve's `/api/event` stream carries no
`session.next.*` events for an engine-placed Session. The attached TUI shows the
submitted prompt and then stays on "Preparing request" — the assistant message
with its tool part never renders and the pending approval never surfaces — while
the same deterministic provider turn against a TypeScript Session delivers
`session.next.prompt.admitted`, `prompted`, `status`, `step.started`,
`text.started`/`delta`/`ended` and `step.ended` on the same stream. This is
observable without any TUI: subscribe to `/api/event` with the Session's
directory header, submit a prompt, and compare a TypeScript Session with a
native one.

The engine and the read side of the native turn are correct. The journal shows
`tool.planned`, `message.committed`, `pre_tool_use`, `approval.requested` (with
request id, input hash, policy revision and expiry) and the `permission_request`
announcement to the serve; the HTTP read projection (`/message`, `/context`)
contains the assistant tool part; and under an allow rule the write executes
without asking. Only the live stream is missing.

</details>

| Behavior | Existing automated evidence | Product acceptance still required |
| --- | --- | --- |
| Prompt and streamed answer | `tests/acp.rs`; product `native-coding-http.test.ts` | Daily TUI verified 2026-10-16 (live stream and rendered tool part); an external ACP client still required |
| Approval and denial | ACP request_permission scenario; product approval/reply tests; independent ACP SDK allow/reject (#912) | Pending approval, grant and rejection verified in the TUI 2026-10-16; third-party editor UI still required |
| Cancellation | `tests/acp_client_matrix.rs`: incomplete HTTP response, cancelled prompt reply, successful continuation (#861); independent ACP SDK cancel/continue (#912) | TUI cancel verified 2026-10-16 (no replacement provider request, Session recovers); third-party editor UI still required |
| Provider failure | ACP HTTP 400 followed by a successful new prompt; failure is a JSON-RPC error, not end_turn (#861) | Visible error and usable next prompt in actual clients |
| Process restart/resume | ACP process replacement on the same DB: prior context retained, prior answer not streamed twice (#861) | Client reconnect without duplicate messages or cross-engine takeover |
| Slow client | HTTP SSE/cursor and restore coverage | Bound the real client's backlog, disconnect it and resume from its cursor |
| Step accounting | Product bridge and native journal tests (#850); HTTP history verifies per-message tokens, and Session GET verifies two-turn/cache totals (#911) | Full TUI cache/TTFT presentation and per-model usage summary still require acceptance; native pricing remains zero until price resolution lands |

These deterministic peers use no paid model calls. Their oracle is the observed
wire response, committed history and next provider request, rather than a
second implementation of the engine logic.

## Installation and confinement (G4)

| Platform | Installer evidence | Still required |
| --- | --- | --- |
| macOS | ZIP/checksum fixture drill (#862); verified CI 0.2.9 binary install/upgrade/rollback from tag-built 0.2.8; arm64 and translated x64 startup; published 0.2.11 archive verified, Gatekeeper launch under quarantine passed ([0.2.11 report](artifact-acceptance-0.2.11.md)); published 0.2.22→0.2.23 artifact drill passed ([0.2.23 report](artifact-acceptance-0.2.23.md)) | Native Intel hardware |
| Linux | tar.gz/checksum fixture drill (#862); verified musl CI binary install/upgrade/rollback from tag-built 0.2.8; published 0.2.11 archive verified on the platform ([0.2.11 report](artifact-acceptance-0.2.11.md)); the published 0.2.23 asset links against GLIBC 2.43 and cannot start on Ubuntu 24.04, fixed by #1235's musl build pending the next release | Repetition against the next published archive |
| Windows | Installer fixture CI under PowerShell 5.1/7 (#864); real x64 CI binary install/upgrade/rollback from tag-built 0.2.8 under PS5.1; published 0.2.11 startup; published 0.2.12→0.2.13→rollback under PS7 7.6.7 with archive and slot hashes verified ([0.2.13 report](artifact-acceptance-0.2.13.md)); published 0.2.22→0.2.24 artifact drill passed, including confinement ([0.2.23 report](artifact-acceptance-0.2.23.md)) | Windows direct release-endpoint connectivity not exercised by the PS7 drill |

Fixture executables prove installer behavior, not engine confinement. The
engine process/sandbox tests remain the confinement evidence, and must be
repeated against the distributed binaries. The v0.2.9 release had no engine
assets at inspection time; v0.2.11 ships engine archives for every supported
platform, and the [0.2.11 artifact acceptance report](artifact-acceptance-0.2.11.md)
closes published-archive verification and macOS Gatekeeper behavior. What
remains open is recorded there.

The [0.2.23 artifact acceptance report](artifact-acceptance-0.2.23.md) records
the current macOS/Windows drills and the Linux glibc defect. The
[0.2.9 artifact acceptance report](artifact-acceptance-0.2.9.md) records
the exact run, commit and hashes for the real binary drills above. It explicitly
does not mark release publication or database downgrade verified.

## Capability families (G6)

| Capability | Engine implementation evidence | Product gap / acceptance task |
| --- | --- | --- |
| Read/edit/patch with approvals | coding and patch tests; product native coding HTTP tests | Actual TUI edit, refusal, undo and retry with preserved contents |
| LSP | `tests/lsp.rs`; explicit installed-server scenario | Verify the global LSP config reaches the native process and diagnostics appear in the product |
| MCP | `tests/mcp.rs` | Attach a user-configured MCP service, exercise tools and cancellation in the actual client |
| Plugins/workflows | `tests/worker.rs`, hooks tests; product plugin-tool and hook bridges (#1172, #1180, #1198); worktree (#1178) and workflow (#1193) over the product-tool bridge | Inventory used plugins/workflows; run each through the compatibility worker, including failure and restart |
| Credentials | credential-store tests and read-only engine ownership; expired-credential broker trigger (#1183) | Real expiry/refresh with a native Session; never create a second refresh authority |
| Session-owned terminals | Unix terminal and guardian tests; Windows ConPTY CI covers startup/input/resize/exit/session isolation, with the unconfined-console fallback reported in `sandbox_profile` | Unix TUI terminal workflow |
| Delegation | subagent/reference tests and settlement token evidence; native progress reports (#1194) | Actual client child-session rendering, cancellation and parent/child cost attribution |
| Role routing | roles tests and one escalation | Summarize consumer exists; retrieve/verify consumers and live quality/cost evidence remain open |
| Global configuration | native-engine-config tests (#857) | Real startup using the global engine section; environment overrides must remain explicit |

### Native LSP configuration

The global `engine.lsp_config` field selects the native engine's existing LSP
host configuration file. Relative paths resolve against the global config
directory, rather than a Session workspace. `MIAO_ENGINE_LSP_CONFIG` is the
operator override (resolved against the process working directory). The
resolved path reaches the child as `--lsp-config`; it does not automatically
translate the TypeScript runner's LSP definitions or prove diagnostics are
rendered in a real client. Keep that product acceptance row open until tested.

## Closing a row

Record the commit and artifact identifier, platform/client version, exact
scenario, observable outcome and failure/recovery evidence. For a required
capability that remains unavailable (notably Windows native terminals), record
an explicitly accepted replacement or keep G6 open. Do not delete the legacy
execution path on the strength of this table alone.
