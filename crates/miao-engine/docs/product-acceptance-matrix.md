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

| Behavior | Existing automated evidence | Product acceptance still required |
| --- | --- | --- |
| Prompt and streamed answer | `tests/acp.rs`; product `native-coding-http.test.ts` | Native-owned Session in the daily TUI and an external ACP client |
| Approval and denial | ACP request_permission scenario; product approval/reply tests | Visible pending approval, grant and denial in each actual client |
| Cancellation | `tests/acp_client_matrix.rs`: incomplete HTTP response, cancelled prompt reply, successful continuation (#861) | Cancel from the TUI and external client; verify no later tool dispatch |
| Provider failure | ACP HTTP 400 followed by a successful new prompt; failure is a JSON-RPC error, not end_turn (#861) | Visible error and usable next prompt in actual clients |
| Process restart/resume | ACP process replacement on the same DB: prior context retained, prior answer not streamed twice (#861) | Client reconnect without duplicate messages or cross-engine takeover |
| Slow client | HTTP SSE/cursor and restore coverage | Bound the real client's backlog, disconnect it and resume from its cursor |
| Step accounting | Product bridge and native journal tests (#850) | TUI consumes tokens/cache/TTFT; native pricing is still zero until price resolution lands |

These deterministic peers use no paid model calls. Their oracle is the observed
wire response, committed history and next provider request, rather than a
second implementation of the engine logic.

## Installation and confinement (G4)

| Platform | Installer evidence | Still required |
| --- | --- | --- |
| macOS | ZIP/checksum fixture drill (#862); verified CI 0.2.9 binary install/upgrade/rollback from tag-built 0.2.8; arm64 and translated x64 startup | Published archive, notarization/Gatekeeper, native Intel hardware and data downgrade compatibility |
| Linux | tar.gz/checksum fixture drill (#862); verified musl CI binary install/upgrade/rollback from tag-built 0.2.8 | Published archive, distributed-binary confinement and data downgrade compatibility |
| Windows | Installer fixture CI under PowerShell 5.1/7 (#864); real x64 CI binary install/upgrade/rollback from tag-built 0.2.8 under PS5.1 | Published ZIP verification, actual-artifact PS7 drill, confinement and data downgrade compatibility |

Fixture executables prove installer behavior, not engine confinement. The
engine process/sandbox tests remain the confinement evidence, and must be
repeated against the distributed binaries. The v0.2.9 draft had no engine
assets at inspection time; publication acceptance is open.

The [0.2.9 artifact acceptance report](artifact-acceptance-0.2.9.md) records
the exact run, commit and hashes for the real binary drills above. It explicitly
does not mark release publication or database downgrade verified.

## Capability families (G6)

| Capability | Engine implementation evidence | Product gap / acceptance task |
| --- | --- | --- |
| Read/edit/patch with approvals | coding and patch tests; product native coding HTTP tests | Actual TUI edit, refusal, undo and retry with preserved contents |
| LSP | `tests/lsp.rs`; explicit installed-server scenario | Verify the global LSP config reaches the native process and diagnostics appear in the product |
| MCP | `tests/mcp.rs` | Attach a user-configured MCP service, exercise tools and cancellation in the actual client |
| Plugins/workflows | `tests/worker.rs`, hooks tests | Inventory used plugins/workflows; run each through the compatibility worker, including failure and restart |
| Credentials | credential-store tests and read-only engine ownership | Expiry/refresh through the product-owned writer; never create a second refresh authority |
| Session-owned terminals | Unix terminal and guardian tests | Unix TUI terminal workflow; Windows engine terminal tools are not advertised yet |
| Delegation | subagent/reference tests and settlement token evidence | Actual client child-session rendering, cancellation and parent/child cost attribution |
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
