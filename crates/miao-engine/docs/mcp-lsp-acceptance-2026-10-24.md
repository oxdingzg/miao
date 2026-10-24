# MCP + LSP real-client acceptance (2026-10-24)

These checks use the released 0.2.26 product, isolated data directories, and
native Session placement. The real TUI displays `Native · Host default Native
runtime`; the corresponding engine journal supplies the structured evidence.
No credential values are included in this record.

## MCP: attach, tools, and client interruption

The official open-source `@modelcontextprotocol/server-everything` stdio
server is configured as a local MCP server. The TUI displays `1 MCP`, and an
`echo` call returns `Echo: MCP-NATIVE-OK` in the product.

Client interruption is verified by durable events, not by spinner changes.
In Session `ses_gfe5e94c15027ffe8zuud5gMaF`, run
`9626e3bd-c60f-4f79-96bd-474701ef3051`:

| Sequence | Evidence |
| --- | --- |
| 15 | Assistant commits a tool call with `duration: 60` |
| 18 | `tool.dispatched` for that call |
| 19 | Matching error tool result: `Execution interrupted; outcome unknown. Do not automatically repeat side effects.` |
| 21 | `run.finished` with `reason: interrupted` |
| 22 | `stop` with `reason: interrupted` |

A second explicit prompt repeats this sequence at 36–40. There is no
`tool.completed` success result for either interrupted call. The journal's
`unknown` tool state is deliberate: client interruption cannot establish that
an external operation stopped or undo effects it may already have performed.
It must not be interpreted as successful completion or automatically replayed.

This verifies interruption through a real client after tool dispatch. It does
**not** establish that the server received `notifications/cancelled`, or that
server-side execution stopped. The earlier claim that the server kept running
"even after the cancelled notification" was unsupported and is withdrawn.

## LSP: real Pyright diagnostics rendered in the native TUI

Use the open-source Pyright language server 1.1.414 with a native manifest:

```json
[
  {
    "name": "python",
    "argv": ["/path/to/pyright-langserver", "--stdio"],
    "extensions": [".py"],
    "env": {},
    "initialization": {}
  }
]
```

Pass its path with `MIAO_ENGINE_LSP_CONFIG` and opt new Sessions into native
placement with `MIAO_ENGINE_STORAGE`. Open this file in the workspace:

```python
count: int = "not an integer"
```

Ask the native Session to call `lsp_diagnostics` on `example.py`. In Session
`ses_gfe5e94735790ffedX053H47p1`, event 19 is `tool.completed` with:

- `source: Pyright`, `code: reportAssignmentType`, `severity: 1`;
- range line 0, characters 13–29;
- message: the string literal is not assignable to `int`;
- `document_version: 1`, `diagnostics_version: 1`, `stale: false`,
  `version_verified: true`.

The TUI renders the LSP tool part and the diagnostic JSON, followed by the
assistant explaining the error. This satisfies the real-language-server,
native-process, product-rendering acceptance without a paid account or native
compilation.

## Rust-specific empty diagnostics remain an investigation

The earlier rust-analyzer run returned an empty diagnostic set for a Rust type
error. That alone does not establish a push-timing bug: the engine already
opens the document and waits for `publishDiagnostics` for up to three seconds.
Rust semantic diagnostics may also depend on `cargo check`, which is blocked
by the workstation's no-local-compilation policy. Neither cause has yet been
isolated for that run. #1304 tracks the Rust-specific investigation; the
previous asserted root cause is withdrawn. The successful Pyright run above
independently verifies the native LSP diagnostics path.
