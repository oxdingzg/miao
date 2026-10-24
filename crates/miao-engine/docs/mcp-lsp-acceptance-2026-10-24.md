# MCP + LSP real-client acceptance (2026-10-24)

Both acceptances were driven against the **released 0.2.26 product** in an
isolated sandbox (own `XDG_DATA_HOME`, copied config + credentials, the
`commandcode/deepseek` route with the owner's API key — no gateway models), on
the **native runtime** (TUI footer: `Native · Host default Native runtime`;
engine journal under the sandbox `engines/` directory).

## MCP: user-configured server attach, tools, cancellation

Server: the official open-source test server
`@modelcontextprotocol/server-everything` (stdio), added exactly as a user
would: `miao mcp add everything -- bunx -y @modelcontextprotocol/server-everything`,
then the session started from the TUI.

| Check | Result |
| --- | --- |
| Attach | TUI status bar shows `⊙ 1 MCP`; the engine spawns the server over stdio |
| Tools | `echo` called with `message=MCP-NATIVE-OK`; TUI renders `● custom [message=…]` and the model quotes `Echo: MCP-NATIVE-OK` |
| Headless parity | `miao run --engine native` against the same server returns `Echo: MCP-ACCEPTANCE-OK` |
| Cancellation | `session.interrupt` (Esc) during `trigger-long-running-operation` stops the turn: the spinner ends, the model's after-interrupt turn runs, and the in-flight tool result is never delivered to the model |

Journal nuance, recorded honestly: the engine's `engine_tool` rows for the
interrupted call end as `unknown`/`completed` because the everything server
finishes its sleep server-side even after the cancelled notification; the
user-visible cancellation is the accepted behavior, and a stricter
row-level `cancelled` state for MCP tools can be a follow-up hardening.

## LSP: a real language server through the native process — partial, follow-up filed

The plumbing is verified end to end: with `"lsp": true` in the sandbox config
and rust-analyzer installed, the engine spawned the real language server and
the agent executed `lsp_diagnostics` on a cargo project seeded with a type
error (`let count: String = 5;`). `engine_tool` journals
`lsp_diagnostics | completed` with structured input, and the tool returned a
well-formed (but empty) diagnostics result — twice, minutes apart, while
rust-analyzer itself flags `E0308` at src/main.rs:2:22.

Root cause (filed as #1304): rust-analyzer publishes diagnostics via
notifications after analysis; the engine's query lands before the first push
and returns an empty set. Until #1304 lands, "diagnostics rendered in the
product" cannot be accepted — this section documents the verified plumbing and
the open gap.
