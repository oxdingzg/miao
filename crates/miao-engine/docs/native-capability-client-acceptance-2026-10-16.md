# Native capability client acceptance — 2026-10-16

G6 evidence collected through the published v0.2.13 macOS arm64 executable and
the independent ACP SDK client. Provider responses and host peers are
local deterministic fixtures; no paid model calls are used.

Executable cases live in
`packages/miao/test/engine/native-acp-capabilities.test.ts`. They run alongside
`native-acp-sdk.test.ts` in the Linux/macOS engine workflow, with an explicit
engine binary path so the cases are not silently skipped.

| Capability | External boundaries exercised | Oracles |
| --- | --- | --- |
| Operator-configured MCP | Host config outside the writable workspace → stdio MCP child → catalog → provider tool call → ACP client | Original `echo/value` name and arguments reach the host, normalized tool name is present in the provider catalog, host result reaches the follow-up provider request, ACP emits tool completion and final text |
| Operator-configured LSP | Host config → real framed language-server child → file open and hover → ACP client | Peer records `textDocument/didOpen` and hover coordinates, hover result reaches the provider, ACP emits tool completion and final text |
| Delegation completion | ACP prompt → `task` → isolated child Session → parent continuation | Child request excludes parent prompt, child answer reaches parent, ledger preserves parent/child lineage and child billed token/turn evidence, parent answer reaches client |
| Parent cancellation during delegation | Child provider receipt → ACP cancel parent → continuation | Client receives `cancelled`, parent records interrupted `subagent_stop`, no replacement provider request occurs before a new prompt, parent accepts and answers the next prompt |

Local result including the existing grant/reject/cancel/resume cases: **7 pass,
54 assertions**. Package typecheck passed. Shared ACP transport cleanup closes
stdin and waits for exit, with a bounded kill fallback for host-peer cleanup.

## Scope retained

- MCP and LSP are explicitly operator-configured host services, with configs
  outside the writable workspace. These tests do not claim support for
  client-supplied ACP `mcpServers`, arbitrary URLs, or automatic configuration
  import.
- The MCP round trip checks one normal result, not resource/prompt UI, OAuth,
  every transport or every failure mode.
- The LSP round trip checks file-open/hover and client delivery, not a real
  compiler's diagnostics UI or every navigation operation.
- Delegation verifies linkage, result and interruption evidence, not live
  quality/cost benefit, purpose-role routing, all worker/plugin workflows or a
  third-party editor's parent/child UI.
- macOS used the actual published executable. CI exercises source-built
  Linux/macOS executables. Windows/client-UI capability acceptance remains
  separate work.
